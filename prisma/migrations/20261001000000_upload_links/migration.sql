-- Open upload links for photographer firms.
--
-- A firm has one login and photographers in several states. This lets the firm
-- mint Google-Drive-style links that upload into the ERP with no account, while
-- every byte still lands inside the firm's one folder and is charged against the
-- firm's one 1 TB ceiling.
--
-- Purely additive: four new tables, five new nullable columns, one backfill.
-- Nothing existing is dropped or rewritten.
--
-- Hand-written, because this project's migration history has drifted from the
-- live database (sales_module.sql was applied directly) and `prisma migrate dev`
-- therefore wants a destructive reset. Apply with `npx prisma migrate deploy`.

-- ---------------------------------------------------------------------------
-- PhotographerProfile.folderName — the firm's folder inside every event.
-- ---------------------------------------------------------------------------

ALTER TABLE "PhotographerProfile" ADD COLUMN "folderName" TEXT;

-- Backfill from the account name, sanitised byte-for-byte the way
-- lib/uploadKey.ts sanitizeSegment does it, in the same order:
--   [^a-zA-Z0-9._ -] -> "_",  leading dots -> "_",  trim,  120 chars,  "_" if empty.
-- Anything else and the stored folder name would not equal the prefix the key
-- builder produces from it, so the firm's own files would fail the root check.
--
-- Applied TWICE, matching stableSegment() in lib/upload-links.ts. One pass is
-- not a fixed point: it strips leading dots before trimming and cuts to 120
-- after, so " .Acme" lands as ".Acme" and sanitising THAT gives "_Acme". The
-- stored name is compared against paths derived from keys, which are sanitised
-- again on the way through, so a name that moves under a second pass is a name
-- whose own files sit outside it — the gallery and the folder picker would
-- silently show nothing while uploads carried on working.
--
-- Uniqueness is CLAIMED row by row, not computed in one pass, because a value
-- has to be unique against every OTHER account's value and not merely against
-- the accounts that share its base name. A set-based backfill that suffixes
-- only within identical bases cannot see that: two accounts named "Acme" both
-- become "Acme (<uid>)", while a third account literally named "Acme (<that
-- uid>)" sanitises straight to the same string — nothing suffixes it, because
-- its own base is unique — and CREATE UNIQUE INDEX below aborts the whole
-- migration. The same goes for an account whose name already ends " 2" against
-- a numbered candidate. Those names are contrived, but a migration that fails
-- on them fails the deploy, and the recovery is hand-editing production.
--
-- So each profile walks the candidate list in order and takes the first name no
-- row holds yet, inside this one transaction, which is exactly what
-- firmFolderCandidates() + the guarded updateMany in lib/upload-links.ts do for
-- an account created after this migration. Same order, same strings:
--   1. the sanitised name;
--   2. "<name cut to 100> (<uid>)";
--   3. "<name cut to 110> <2..50>";
-- and then two backstops the TypeScript does not need (it can keep retrying
-- against a live unique index, a migration cannot): a stable fragment of the
-- account id, and the whole account id. Both are unique per account by
-- construction and both survive sanitising unchanged — hex digits and "-" are
-- in the allowed set — so the loop terminates with a usable name.
--
-- Ordered by "userId" so the outcome does not depend on the planner's row order.
DO $$
DECLARE
  r         RECORD;
  base      TEXT;
  raw       TEXT;
  candidate TEXT;
  chosen    TEXT;
  attempt   INT;
  pass      INT;
BEGIN
  FOR r IN
    SELECT p."userId", u."name", u."uid"
      FROM "PhotographerProfile" p
      JOIN "User" u ON u."id" = p."userId"
     WHERE p."folderName" IS NULL
     ORDER BY p."userId"
  LOOP
    -- stableSegment(u."name"): one sanitising pass is not a fixed point, so two.
    base := r."name";
    FOR pass IN 1..2 LOOP
      base := COALESCE(
        NULLIF(left(btrim(regexp_replace(regexp_replace(base, '[^a-zA-Z0-9._ -]', '_', 'g'), '^\.+', '_')), 120), ''),
        '_'
      );
    END LOOP;

    chosen := NULL;
    FOR attempt IN 0..52 LOOP
      -- The base is cut before the suffix is appended so the suffix cannot be
      -- the part that falls off the 120-character limit.
      IF attempt = 0 THEN
        raw := base;
      ELSIF attempt = 1 THEN
        raw := left(base, 100) || ' (' || r."uid" || ')';
      ELSIF attempt <= 50 THEN
        raw := left(base, 110) || ' ' || attempt::text;
      ELSIF attempt = 51 THEN
        raw := left(base, 100) || ' ' || substr(md5(r."userId"), 1, 8);
      ELSE
        raw := left(base, 80) || ' ' || replace(r."userId", '-', '');
      END IF;

      candidate := raw;
      FOR pass IN 1..2 LOOP
        candidate := COALESCE(
          NULLIF(left(btrim(regexp_replace(regexp_replace(candidate, '[^a-zA-Z0-9._ -]', '_', 'g'), '^\.+', '_')), 120), ''),
          '_'
        );
      END LOOP;

      -- Rows already updated by earlier iterations of this loop are visible
      -- here, which is what makes the claim global rather than per base name.
      IF NOT EXISTS (SELECT 1 FROM "PhotographerProfile" WHERE "folderName" = candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;

    IF chosen IS NULL THEN
      RAISE EXCEPTION 'folderName backfill exhausted every candidate for %', r."userId";
    END IF;

    UPDATE "PhotographerProfile" SET "folderName" = chosen WHERE "userId" = r."userId";
  END LOOP;
END $$;

CREATE UNIQUE INDEX "PhotographerProfile_folderName_key"
  ON "PhotographerProfile"("folderName");

-- ---------------------------------------------------------------------------
-- PhotographerProfile.lastSweptAt — the rate limit on opportunistic sweeps.
-- ---------------------------------------------------------------------------

-- Two sweeps run on the critical path of starting a file: abandoned presign
-- charges (at /api/uploads/presign) and abandoned multipart sessions (at
-- /api/uploads/multipart create). Both are reachable by anyone holding a
-- forwarded upload link, so a scripted flood would pay for one sweep per
-- request — the housekeeping that exists to survive a flood becoming the most
-- expensive part of it.
--
-- A sweep is now CLAIMED: one conditional UPDATE moves this column forward, and
-- only the writer that moves it sweeps. The work is therefore bounded at one
-- pass per firm per minute no matter how many requests arrive, and the claim
-- costs a single indexed UPDATE on a row the request is about to lock anyway.
--
-- NULL means "never swept" and always wins the claim, so an existing profile
-- needs no backfill.
ALTER TABLE "PhotographerProfile" ADD COLUMN "lastSweptAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- UploadLink
-- ---------------------------------------------------------------------------

CREATE TABLE "UploadLink" (
    "id"             TEXT NOT NULL,
    -- Stored raw, not hashed: the firm must be able to copy the link again, and
    -- the token IS the link. 24 random bytes, base64url.
    "token"          TEXT NOT NULL,
    "photographerId" TEXT NOT NULL,
    "eventId"        TEXT NOT NULL,
    "label"          TEXT,
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    -- Soft revoke, staff only — the same rule as a client share link.
    "revokedAt"      TIMESTAMP(3),
    "revokedById"    TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt"     TIMESTAMP(3),

    CONSTRAINT "UploadLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UploadLink_token_key" ON "UploadLink"("token");
CREATE INDEX "UploadLink_photographerId_idx" ON "UploadLink"("photographerId");
CREATE INDEX "UploadLink_eventId_idx" ON "UploadLink"("eventId");

-- CASCADE on the two columns that define the link: a link to a deleted event, or
-- one held by a deleted account, means nothing. revokedById is audit trail and
-- survives the employee leaving.
ALTER TABLE "UploadLink"
  ADD CONSTRAINT "UploadLink_photographerId_fkey"
  FOREIGN KEY ("photographerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UploadLink"
  ADD CONSTRAINT "UploadLink_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UploadLink"
  ADD CONSTRAINT "UploadLink_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- UploadContributor — one person who has used a link.
-- ---------------------------------------------------------------------------

CREATE TABLE "UploadContributor" (
    "id"         TEXT NOT NULL,
    "linkId"     TEXT NOT NULL,
    -- What they typed, trimmed, for display and attribution.
    "name"       TEXT NOT NULL,
    -- Sanitised "<Name> <YYYY-MM-DD HH.mm>" (IST), inside the firm's folder.
    "folderName" TEXT NOT NULL,
    -- sha256 hex of the secret their browser keeps. The link is a bearer value
    -- anyone can forward, so it cannot identify a person; this can.
    "secretHash" TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    -- Last time an upload email went out on this person's behalf. The notify
    -- endpoint accepts link credentials, so without a mark on the row anyone
    -- holding a forwarded link could drive mail to the firm's address in a
    -- loop; a send is claimed by moving this forward, and only an upload that
    -- arrived after it can claim the next one.
    "lastNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "UploadContributor_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UploadContributor_linkId_idx" ON "UploadContributor"("linkId");

ALTER TABLE "UploadContributor"
  ADD CONSTRAINT "UploadContributor_linkId_fkey"
  FOREIGN KEY ("linkId") REFERENCES "UploadLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- MediaFolder — folders that exist before they hold anything.
-- ---------------------------------------------------------------------------

CREATE TABLE "MediaFolder" (
    "id"            TEXT NOT NULL,
    "eventId"       TEXT NOT NULL,
    -- Full path relative to the event, e.g. "Acme Studios/Ravi 2026-10-01 14.32/Day 1".
    "path"          TEXT NOT NULL,
    "createdById"   TEXT,
    "contributorId" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaFolder_pkey" PRIMARY KEY ("id")
);

-- Creating a folder twice is a no-op, not a second folder.
CREATE UNIQUE INDEX "MediaFolder_eventId_path_key" ON "MediaFolder"("eventId", "path");

-- Both are read as filters, never as a scan: "this person's folders" for the
-- per-contributor breakdown, "this firm's" for the main-account one.
CREATE INDEX "MediaFolder_contributorId_idx" ON "MediaFolder"("contributorId");
CREATE INDEX "MediaFolder_createdById_idx" ON "MediaFolder"("createdById");

ALTER TABLE "MediaFolder"
  ADD CONSTRAINT "MediaFolder_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MediaFolder"
  ADD CONSTRAINT "MediaFolder_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaFolder"
  ADD CONSTRAINT "MediaFolder_contributorId_fkey"
  FOREIGN KEY ("contributorId") REFERENCES "UploadContributor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Attribution on the rows that already exist.
-- ---------------------------------------------------------------------------

-- Which of the firm's people sent this file. NULL means the firm's own login,
-- or an employee. SET NULL rather than CASCADE: losing the contributor record
-- must never delete the event's files.
ALTER TABLE "Upload" ADD COLUMN "contributorId" TEXT;

CREATE INDEX "Upload_contributorId_idx" ON "Upload"("contributorId");

-- "Upload" has carried nothing but its primary key since the init migration,
-- and open links put three unauthenticated readers of it in front of every
-- quota, ceiling and storage check this feature has:
--
--   * /api/upload-links/public/<token>/folders — SELECT DISTINCT
--     regexp_replace("fileUrl", ...) WHERE "eventId" = $1, i.e. a sequential
--     scan plus a regexp per row plus a hash aggregate;
--   * /api/uploads — the registration dedupe, findFirst on (eventId, fileUrl),
--     which runs before the HEAD that would reject the request;
--   * /api/uploads/multipart create — the "is this key already spoken for?"
--     check, which is now passed its eventId so that this one index serves it
--     too rather than needing a second on "fileUrl" alone.
--
-- Nothing in the app is rate limited, and this instance holds hundreds of
-- gigabytes of client media across 28 events, so a loop on a forwarded link
-- bought a full table scan per ~300-byte request — and the dashboard, tasks and
-- sales pages queue behind it, because they share the instance. The composite
-- also covers the plain "WHERE eventId" reads (the gallery, the ZIP, the
-- per-link stats), which had no index either.
CREATE INDEX "Upload_eventId_fileUrl_idx" ON "Upload"("eventId", "fileUrl");

ALTER TABLE "Upload"
  ADD CONSTRAINT "Upload_contributorId_fkey"
  FOREIGN KEY ("contributorId") REFERENCES "UploadContributor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Binds a multipart session to the contributor that opened it. No foreign key:
-- it is an equality check against a value the server already holds, and this
-- table is swept by a janitor rather than kept in step with anything.
ALTER TABLE "MultipartSession" ADD COLUMN "contributorId" TEXT;

-- Which link the session came through, NULL for the firm's main login and for
-- employees. The pending-bytes ceiling has a per-LINK tier between the
-- per-contributor one and the firm's: a link is a bearer URL that may have been
-- forwarded to a whole crew, and that crew must not be able to spend what the
-- firm's other links need. Deriving it by joining every contributor of the link
-- would mean an IN list of up to a thousand ids inside the charging
-- transaction, on the critical path of every large file. No foreign key, as on
-- "contributorId".
ALTER TABLE "MultipartSession" ADD COLUMN "linkId" TEXT;

-- The per-link pending-bytes ceiling: OPEN sessions of one link.
CREATE INDEX "MultipartSession_linkId_state_idx"
  ON "MultipartSession"("linkId", "state");

-- "Has another upload already claimed this key?" — asked by multipart create
-- before it opens anything, and until now answered by reading every OPEN and
-- COMPLETED row in the table. COMPLETED rows are never deleted, so that cost
-- grows with every legitimate upload forever, and a link holder looping create
-- could add to it on purpose.
CREATE INDEX "MultipartSession_key_state_idx"
  ON "MultipartSession"("key", "state");

-- The pending-bytes tiers are all "this firm's OPEN sessions", narrowed by
-- contributorId or linkId. Nothing indexed "userId", so every tier aggregate
-- scanned the table — inside the charging transaction, holding the firm's
-- PhotographerProfile row lock.
CREATE INDEX "MultipartSession_userId_state_idx"
  ON "MultipartSession"("userId", "state");

-- ---------------------------------------------------------------------------
-- MultipartSession.lastActivityAt — when this upload was last handed part URLs.
-- ---------------------------------------------------------------------------

-- The firm-wide cap on bytes held by uploads that have not landed sums every
-- OPEN session of the firm, main login and every contributor together. A browser
-- tab closed mid-upload kept its bytes in that sum until the janitor swept it
-- seven days later, so one dead laptop rationed a whole firm's legitimate work.
--
-- With this column "dead" becomes provable rather than guessed: it is stamped at
-- create and refreshed by every successful `sign`, and after it plus PART_EXPIRY
-- no part URL the session ever received is still valid — the upload cannot
-- advance without asking for more, which would move the column. Readers
-- COALESCE to "createdAt" for the rows that predate it, which is the value it
-- would have held.
ALTER TABLE "MultipartSession" ADD COLUMN "lastActivityAt" TIMESTAMP(3);

CREATE INDEX "MultipartSession_state_lastActivityAt_idx"
  ON "MultipartSession"("state", "lastActivityAt");

-- ---------------------------------------------------------------------------
-- UploadCharge — one quota authorisation for one object key.
-- ---------------------------------------------------------------------------

-- /api/uploads/presign charges a photographer for the single-PUT original and
-- for every thumb/preview slot it signs, before any of those objects exist —
-- signing is the only moment at which a ceiling can be enforced. Nothing ever
-- revisited those charges, so a PUT that never happened debited the firm
-- forever. Open links made that reachable by anyone holding a forwarded URL: a
-- scripted loop of presign calls could pin a firm's whole 1 TB with nothing
-- stored at all.
--
-- A row is settled exactly once. "registered" = the file was registered;
-- "landed" = the object is in storage though nothing claimed it, so the charge
-- stands (refunding stored bytes would be free upload for anyone who PUTs
-- without registering); "refunded" = the object is provably absent and the
-- bytes went back. The null -> now() transition on "settledAt" IS the claim that
-- authorises a refund, so only one writer can ever pay it.
CREATE TABLE "UploadCharge" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "eventId"   TEXT NOT NULL,
    -- Which contributor's presign took the bytes; NULL for the firm's main
    -- login. Every contributor presents the FIRM's user id, so without this the
    -- ceiling could only be firm-wide and one abusing link holder would ration
    -- the firm's own photographers. No foreign key, as on MultipartSession: it
    -- is an equality filter on a value the server already holds, and a revoked
    -- contributor's charges must stay readable for reconciliation.
    "contributorId" TEXT,
    -- Which link that contributor was holding; NULL for the firm's main login.
    -- The ceiling has a per-LINK tier between the per-contributor one and the
    -- firm's, because one link may have been forwarded to a whole crew and that
    -- crew must not be able to spend what the firm's other links need. Stamped
    -- here rather than joined through "UploadContributor": the ceiling is read
    -- inside the charging transaction, on the critical path of every file.
    "linkId"    TEXT,
    -- The object key the bytes were authorised for, derivatives included.
    "key"       TEXT NOT NULL,
    "bytes"     BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL means unsettled.
    "settledAt" TIMESTAMP(3),
    -- 'registered' | 'landed' | 'refunded'; NULL while unsettled.
    "outcome"   TEXT,

    CONSTRAINT "UploadCharge_pkey" PRIMARY KEY ("id")
);

-- The per-firm sweep, and the all-links tier of the unsettled-bytes ceiling
-- (every unsettled row of the firm, filtered on "linkId" IS NOT NULL).
CREATE INDEX "UploadCharge_userId_settledAt_idx" ON "UploadCharge"("userId", "settledAt");

-- The two tiers that filter on "contributorId": the per-contributor one
-- ("contributorId" = $2) and the firm's main-login pool ("contributorId" IS
-- NULL). Neither is covered by the index above, so the main login's own
-- ceiling — the one that exists precisely so that link traffic cannot ration
-- the firm — was read by scanning every unsettled row the firm's links had
-- written, while holding the PhotographerProfile row lock that serialises the
-- firm's charges.
CREATE INDEX "UploadCharge_userId_contributorId_settledAt_idx"
  ON "UploadCharge"("userId", "contributorId", "settledAt");

-- The per-link tier of the same ceiling.
CREATE INDEX "UploadCharge_linkId_settledAt_idx" ON "UploadCharge"("linkId", "settledAt");

-- The all-firms daily sweep: unsettled rows, oldest first.
CREATE INDEX "UploadCharge_settledAt_createdAt_idx" ON "UploadCharge"("settledAt", "createdAt");

-- Registration settles by key, for the original and its two derivative keys.
CREATE INDEX "UploadCharge_key_idx" ON "UploadCharge"("key");

-- CASCADE: a deleted account has no quota left to refund, so its ledger is
-- noise. No foreign key on "eventId" — it is recorded for support questions
-- ("what was this firm charged for on that shoot?"), and a deleted event must
-- not take unsettled charges with it before they can be reconciled.
ALTER TABLE "UploadCharge"
  ADD CONSTRAINT "UploadCharge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
