-- Client delivery links.
--
-- Purely additive: creates one table, touches nothing that exists. Written by
-- hand rather than generated, because this project's migration history has
-- drifted from the database (sales_module.sql was applied directly), which
-- makes `prisma migrate dev` want a full reset. Apply with `migrate deploy`.

CREATE TABLE "MediaShare" (
    "id"           TEXT NOT NULL,
    "eventId"      TEXT NOT NULL,
    "folder"       TEXT,
    "token"        TEXT NOT NULL,
    "createdBy"    TEXT NOT NULL,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "revokedAt"    TIMESTAMP(3),
    "viewCount"    INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "remindedAt"   TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MediaShare_token_key" ON "MediaShare"("token");
CREATE INDEX "MediaShare_eventId_idx" ON "MediaShare"("eventId");
CREATE INDEX "MediaShare_expiresAt_idx" ON "MediaShare"("expiresAt");

ALTER TABLE "MediaShare"
  ADD CONSTRAINT "MediaShare_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MediaShare"
  ADD CONSTRAINT "MediaShare_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
