-- Sales Module v2 — run in Supabase SQL Editor
-- Updates DealStage enum + adds fields to Lead

-- 1. Add new enum values to DealStage
ALTER TYPE "DealStage" ADD VALUE IF NOT EXISTS 'NEEDS_ANALYSIS';
ALTER TYPE "DealStage" ADD VALUE IF NOT EXISTS 'VALUE_PROPOSITION';
ALTER TYPE "DealStage" ADD VALUE IF NOT EXISTS 'IDENTIFY_DECISION_MAKERS';
ALTER TYPE "DealStage" ADD VALUE IF NOT EXISTS 'PROPOSAL_PRICE_QUOTE';
ALTER TYPE "DealStage" ADD VALUE IF NOT EXISTS 'NEGOTIATION_REVIEW';

-- 2. Remove old values that are no longer used (PROPOSAL, NEGOTIATION)
--    Note: PostgreSQL does not support removing enum values directly.
--    Old deals with stage PROPOSAL or NEGOTIATION should be migrated:
UPDATE "Deal" SET "stage" = 'PROPOSAL_PRICE_QUOTE' WHERE "stage" = 'PROPOSAL';
UPDATE "Deal" SET "stage" = 'NEGOTIATION_REVIEW' WHERE "stage" = 'NEGOTIATION';

-- 3. Add new columns to Lead
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "convertedDealId" TEXT;
