-- Event artifacts: the working documents an event accumulates — pitch decks,
-- run-of-show flows, creatives, layouts, customer lists — classified into five
-- fixed categories and stored in the media bucket (R2) under their own key
-- prefix, artifacts/<eventId>/<CATEGORY>/.
--
-- A separate table rather than a flag on "Upload", because "Upload" IS the
-- event's media: the gallery, the client share links, the ZIP builder and the
-- photographer views all read it, and an internal pitch deck must appear in
-- none of them. A new table under a new prefix makes that structural instead of
-- something every one of those readers has to remember to filter on.
--
-- Purely additive: one new enum, one new table. Nothing existing is dropped or
-- rewritten.
--
-- Hand-written, because this project's migration history has drifted from the
-- live database (sales_module.sql was applied directly) and `prisma migrate dev`
-- therefore wants a destructive reset. Apply with `npx prisma migrate deploy` —
-- never `migrate dev`.

-- The order matters: the UI renders one tab per value in this order.
CREATE TYPE "ArtifactCategory" AS ENUM ('PPT', 'EVENT_FLOW', 'CREATIVES', 'LAYOUTS', 'CUSTOMER_DATA');

CREATE TABLE "EventArtifact" (
    "id"           TEXT NOT NULL,
    "eventId"      TEXT NOT NULL,
    "category"     "ArtifactCategory" NOT NULL,
    -- Canonical storage URL, the same form "Upload"."fileUrl" takes:
    -- publicBaseUrl || '/' || key. Reads are routed by this prefix
    -- (lib/storage.ts resolveForUrl), which is what lets S3 and R2 objects
    -- coexist with no backfill.
    "fileUrl"      TEXT NOT NULL,
    -- The name the file had on the uploader's machine. Stored rather than parsed
    -- back out of the key: the key is sanitised and carries a timestamp-and-
    -- nonce stamp, and the person hunting for "Pitch v4 (final).pptx" needs the
    -- name they gave it.
    "fileName"     TEXT NOT NULL,
    "fileType"     TEXT NOT NULL,
    -- Read from storage with a HEAD at registration; NULL when storage answered
    -- without a length.
    "sizeBytes"    BIGINT,
    "uploadedById" TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Deletion is soft, and it is also real: the object is removed from storage
    -- in the same request. The row survives purely so that who deleted what
    -- stays on record — which is the point, since an employee may only delete
    -- their own files and the Managing Director may delete anyone's.
    "deletedAt"    TIMESTAMP(3),
    "deletedById"  TEXT,

    CONSTRAINT "EventArtifact_pkey" PRIMARY KEY ("id")
);

-- Registration is idempotent on (event, URL): a POST retried after a timeout,
-- or a double-clicked Upload, must not leave two rows pointing at one object.
CREATE UNIQUE INDEX "EventArtifact_eventId_fileUrl_key" ON "EventArtifact"("eventId", "fileUrl");

-- The only read on the hot path: one event's live artifacts, by category.
CREATE INDEX "EventArtifact_eventId_category_deletedAt_idx"
  ON "EventArtifact"("eventId", "category", "deletedAt");

-- CASCADE on the event: an artifact of a deleted event means nothing, and under
-- RESTRICT a single pitch deck would permanently block deleting the event
-- (which is how "MediaShare" broke event deletion once already).
ALTER TABLE "EventArtifact"
  ADD CONSTRAINT "EventArtifact_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT on the uploader, matching "Upload"."uploadedBy": the file belongs to
-- the event, and an account must not be deletable out from under the files it
-- put there.
ALTER TABLE "EventArtifact"
  ADD CONSTRAINT "EventArtifact_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL on the deleter: the deletion record outlives the employee who made
-- it, the same way every other audit column here does.
ALTER TABLE "EventArtifact"
  ADD CONSTRAINT "EventArtifact_deletedById_fkey"
  FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
