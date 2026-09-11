-- Research module (phase 1) -- run this in the Supabase SQL Editor.
--
-- Idempotent: every statement is guarded, so re-running it is safe.
-- It creates the pgvector extension, the ten Research* enums, the eight
-- Research* tables, their indexes (including the HNSW cosine index on
-- ResearchIdea.embedding, which Prisma cannot express) and their foreign keys.
--
-- Dashboard > SQL Editor > New query > paste > Run.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE "ResearchSourceKind" AS ENUM ('reddit', 'youtube', 'rss', 'clip', 'web');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchPostStatus" AS ENUM ('new', 'awaiting_comments', 'skipped', 'rejected', 'extracted', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchIdeaStatus" AS ENUM ('active', 'merged', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchScopeCategory" AS ENUM ('activation', 'marketing_activation', 'crowd_engagement', 'event_technology', 'captivating_activity');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchInteractionMode" AS ENUM ('one_to_one', 'one_to_many', 'many_to_many', 'self_guided');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchSetting" AS ENUM ('indoor', 'outdoor', 'hybrid', 'virtual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchBudgetBand" AS ENUM ('low', 'medium', 'high', 'premium');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchIntensity" AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchJobStatus" AS ENUM ('queued', 'running', 'done', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ResearchJobStage" AS ENUM ('expanding', 'web', 'reddit', 'processing');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ResearchSource" (
    "id" TEXT NOT NULL,
    "kind" "ResearchSourceKind" NOT NULL,
    "identifier" TEXT NOT NULL,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pollIntervalMin" INTEGER NOT NULL DEFAULT 60,
    "lastPolledAt" TIMESTAMP(3),
    "backoffUntil" TIMESTAMP(3),
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ResearchPost" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT,
    "kind" "ResearchSourceKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT,
    "author" TEXT,
    "title" TEXT,
    "body" TEXT,
    "comments" JSONB,
    "mediaUrls" JSONB,
    "engagement" JSONB,
    "postedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ResearchPostStatus" NOT NULL DEFAULT 'new',
    "triage" JSONB,
    "extraction" JSONB,
    "error" TEXT,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchPost_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ResearchIdea" (
    "id" TEXT NOT NULL,
    "scopeCategory" "ResearchScopeCategory",
    "title" TEXT,
    "summary" TEXT,
    "howItWorks" TEXT,
    "eventTypes" TEXT[],
    "formats" TEXT[],
    "interactionMode" "ResearchInteractionMode",
    "audienceMin" INTEGER,
    "audienceMax" INTEGER,
    "minutesPerParticipant" DECIMAL(65,30),
    "totalDurationMinutes" DECIMAL(65,30),
    "setting" "ResearchSetting",
    "spaceRequirements" TEXT,
    "techRequirements" TEXT,
    "staffing" TEXT,
    "staffCount" INTEGER,
    "setupTimeMinutes" DECIMAL(65,30),
    "materials" TEXT,
    "budgetBand" "ResearchBudgetBand",
    "budgetNotes" TEXT,
    "audienceTypes" TEXT[],
    "ageGroup" TEXT,
    "brandable" BOOLEAN,
    "physicalIntensity" "ResearchIntensity",
    "region" TEXT,
    "occasion" TEXT,
    "tags" TEXT[],
    "attributes" JSONB,
    "confidence" JSONB,
    "embedding" vector(768),
    "popularityScore" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "status" "ResearchIdeaStatus" NOT NULL DEFAULT 'active',
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchIdea_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ResearchIdeaSource" (
    "ideaId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "extractionIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchIdeaSource_pkey" PRIMARY KEY ("ideaId","postId","extractionIndex")
);

CREATE TABLE IF NOT EXISTS "ResearchSearch" (
    "id" TEXT NOT NULL,
    "needText" TEXT,
    "filters" JSONB,
    "resultIdeaIds" JSONB,
    "answer" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchSearch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ResearchJob" (
    "id" TEXT NOT NULL,
    "needText" TEXT,
    "filters" JSONB,
    "searchId" TEXT,
    "status" "ResearchJobStatus" NOT NULL DEFAULT 'queued',
    "stage" "ResearchJobStage",
    "stats" JSONB,
    "state" JSONB,
    "error" TEXT,
    "userId" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ResearchJobPost" (
    "jobId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchJobPost_pkey" PRIMARY KEY ("jobId","postId")
);

CREATE TABLE IF NOT EXISTS "ResearchJobIdea" (
    "jobId" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "created" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchJobIdea_pkey" PRIMARY KEY ("jobId","ideaId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ResearchSource_kind_identifier_key" ON "ResearchSource"("kind", "identifier");

CREATE INDEX IF NOT EXISTS "ResearchPost_status_idx" ON "ResearchPost"("status");

CREATE INDEX IF NOT EXISTS "ResearchPost_sourceId_idx" ON "ResearchPost"("sourceId");

CREATE UNIQUE INDEX IF NOT EXISTS "ResearchPost_kind_externalId_key" ON "ResearchPost"("kind", "externalId");

CREATE INDEX IF NOT EXISTS "ResearchIdea_status_idx" ON "ResearchIdea"("status");

CREATE INDEX IF NOT EXISTS "ResearchIdea_scopeCategory_idx" ON "ResearchIdea"("scopeCategory");

CREATE INDEX IF NOT EXISTS "ResearchIdeaSource_postId_idx" ON "ResearchIdeaSource"("postId");

CREATE INDEX IF NOT EXISTS "ResearchSearch_createdAt_idx" ON "ResearchSearch"("createdAt");

CREATE INDEX IF NOT EXISTS "ResearchJob_status_idx" ON "ResearchJob"("status");

CREATE INDEX IF NOT EXISTS "ResearchJob_createdAt_idx" ON "ResearchJob"("createdAt");

CREATE INDEX IF NOT EXISTS "ResearchJobPost_postId_idx" ON "ResearchJobPost"("postId");

CREATE INDEX IF NOT EXISTS "ResearchJobIdea_ideaId_idx" ON "ResearchJobIdea"("ideaId");

DO $$ BEGIN
  ALTER TABLE "ResearchPost" ADD CONSTRAINT "ResearchPost_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ResearchSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ResearchIdea" ADD CONSTRAINT "ResearchIdea_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "ResearchIdea"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ResearchIdeaSource" ADD CONSTRAINT "ResearchIdeaSource_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ResearchIdea"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ResearchIdeaSource" ADD CONSTRAINT "ResearchIdeaSource_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ResearchPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ResearchJob" ADD CONSTRAINT "ResearchJob_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "ResearchSearch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ResearchJobPost" ADD CONSTRAINT "ResearchJobPost_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ResearchJobPost" ADD CONSTRAINT "ResearchJobPost_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ResearchPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ResearchJobIdea" ADD CONSTRAINT "ResearchJobIdea_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ResearchJobIdea" ADD CONSTRAINT "ResearchJobIdea_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ResearchIdea"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- --------------------------------------------------------------------------
-- Indexes Prisma's schema cannot express.
-- --------------------------------------------------------------------------

-- Vector similarity: cosine, which is what dedupe and search both use.
CREATE INDEX IF NOT EXISTS "ResearchIdea_embedding_hnsw"
  ON "ResearchIdea" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Array containment for the browse / filter queries. These two ARE in the
-- Prisma schema (@@index(..., type: Gin)), so the names match what Prisma
-- expects and `prisma db push` leaves them alone.
CREATE INDEX IF NOT EXISTS "ResearchIdea_eventTypes_idx"
  ON "ResearchIdea" USING gin ("eventTypes");
CREATE INDEX IF NOT EXISTS "ResearchIdea_tags_idx"
  ON "ResearchIdea" USING gin ("tags");

-- NOTE: `prisma db push` DROPS the HNSW index above, because Prisma has no way
-- to express hnsw and treats an unknown index as drift. Supabase never runs
-- db push, so this only bites local development: re-run this file afterwards
-- (it is idempotent). Without the index, cosine search still returns exactly
-- the same rows, just by sequential scan.
