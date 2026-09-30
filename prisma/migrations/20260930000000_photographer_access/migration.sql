-- Third-party photographer accounts: per-account upload quota, and an explicit
-- per-event access list.
--
-- Purely additive: two new tables, one new nullable column, nothing existing is
-- dropped or rewritten. Written by hand rather than generated, because this
-- project's migration history has drifted from the live database
-- (sales_module.sql was applied directly), which makes `prisma migrate dev`
-- want a full destructive reset. Apply with `npx prisma migrate deploy` —
-- never `migrate dev`.

CREATE TABLE "PhotographerProfile" (
    "userId"         TEXT NOT NULL,
    "quotaBytes"     BIGINT NOT NULL DEFAULT 1000000000000,
    "allocatedBytes" BIGINT NOT NULL DEFAULT 0,
    "createdById"    TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotographerProfile_pkey" PRIMARY KEY ("userId")
);

-- CASCADE: the profile is an attribute of the account, not a record in its own
-- right. Under RESTRICT a photographer account could never be deleted again.
ALTER TABLE "PhotographerProfile"
  ADD CONSTRAINT "PhotographerProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PhotographerProfile"
  ADD CONSTRAINT "PhotographerProfile_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PhotographerEventAccess" (
    "id"             TEXT NOT NULL,
    "photographerId" TEXT NOT NULL,
    "eventId"        TEXT NOT NULL,
    "grantedById"    TEXT NOT NULL,
    "grantedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"      TIMESTAMP(3),
    "revokedById"    TEXT,

    CONSTRAINT "PhotographerEventAccess_pkey" PRIMARY KEY ("id")
);

-- One row per (photographer, event) forever: a re-grant un-revokes the existing
-- row instead of inserting a second one.
CREATE UNIQUE INDEX "PhotographerEventAccess_photographerId_eventId_key"
  ON "PhotographerEventAccess"("photographerId", "eventId");
CREATE INDEX "PhotographerEventAccess_eventId_idx"
  ON "PhotographerEventAccess"("eventId");

-- CASCADE on the two columns that define the grant. Revokes are soft, so a row
-- is never deleted; under RESTRICT one grant would permanently block deleting
-- the event or the photographer's account. A grant to a deleted event, or one
-- held by a deleted account, means nothing and goes with it.
ALTER TABLE "PhotographerEventAccess"
  ADD CONSTRAINT "PhotographerEventAccess_photographerId_fkey"
  FOREIGN KEY ("photographerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PhotographerEventAccess"
  ADD CONSTRAINT "PhotographerEventAccess_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- grantedById / revokedById stay RESTRICT / SET NULL: those are audit trail,
-- not part of the grant, and an employee leaving must not erase who handed a
-- third party access to a shoot.

ALTER TABLE "PhotographerEventAccess"
  ADD CONSTRAINT "PhotographerEventAccess_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PhotographerEventAccess"
  ADD CONSTRAINT "PhotographerEventAccess_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The authoritative record of an open multipart upload.
--
-- The client's signed ticket is tamper-proof but replayable, and R2's
-- AbortMultipartUpload is idempotent: "abort succeeded" is not evidence that
-- anything was discarded. Refunding quota on that evidence let the same bytes
-- be handed back on every call. State lives here instead, and the refund rides
-- on the OPEN -> ABORTED transition, which exactly one caller can win.
CREATE TABLE "MultipartSession" (
    "uploadId"     TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "key"          TEXT NOT NULL,
    "eventId"      TEXT NOT NULL,
    -- "media" | "document": which storage profile, so the janitor knows the bucket.
    "purpose"      TEXT NOT NULL DEFAULT 'media',
    "fileSize"     BIGINT NOT NULL,
    "partSize"     BIGINT NOT NULL,
    -- Quota reserved at create time. 0 for employees, who have no ceiling.
    "bytesCharged" BIGINT NOT NULL DEFAULT 0,
    -- OPEN | COMPLETED | ABORTED. Only OPEN may be claimed.
    "state"        TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"     TIMESTAMP(3),

    CONSTRAINT "MultipartSession_pkey" PRIMARY KEY ("uploadId")
);

-- The janitor's query: OPEN rows older than a cutoff.
CREATE INDEX "MultipartSession_state_createdAt_idx"
  ON "MultipartSession"("state", "createdAt");

ALTER TABLE "MultipartSession"
  ADD CONSTRAINT "MultipartSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable: rows written before this column existed have no size on record.
-- scripts/backfill-upload-sizes.mts fills them in from storage.
ALTER TABLE "Upload" ADD COLUMN "sizeBytes" BIGINT;

-- The shared photographer account predates this feature. Give every existing
-- photographer the default quota so the limit applies to them too.
INSERT INTO "PhotographerProfile" ("userId", "createdById")
SELECT "id", NULL FROM "User" WHERE "role" = 'PHOTOGRAPHER'
ON CONFLICT ("userId") DO NOTHING;
