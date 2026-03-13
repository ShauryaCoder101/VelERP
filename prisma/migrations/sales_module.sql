-- Sales Module migration — run in Supabase SQL Editor

-- Enums
DO $$ BEGIN
  CREATE TYPE "LeadSource" AS ENUM ('WEBSITE', 'REFERRAL', 'SOCIAL_MEDIA', 'COLD_CALL', 'EVENT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DealStage" AS ENUM ('QUALIFICATION', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Lead table
CREATE TABLE IF NOT EXISTS "Lead" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "name" TEXT NOT NULL,
  "company" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
  "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
  "notes" TEXT,
  "assignedTo" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- SalesContact table
CREATE TABLE IF NOT EXISTS "SalesContact" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "company" TEXT,
  "designation" TEXT,
  "accountId" TEXT,
  "notes" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesContact_pkey" PRIMARY KEY ("id")
);

-- Account table
CREATE TABLE IF NOT EXISTS "Account" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "companyName" TEXT NOT NULL,
  "industry" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "website" TEXT,
  "address" TEXT,
  "notes" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- Deal table
CREATE TABLE IF NOT EXISTS "Deal" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "dealName" TEXT NOT NULL,
  "accountId" TEXT,
  "stage" "DealStage" NOT NULL DEFAULT 'QUALIFICATION',
  "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "expectedCloseDate" TIMESTAMP(3),
  "notes" TEXT,
  "assignedTo" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedTo_fkey"
  FOREIGN KEY ("assignedTo") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SalesContact" ADD CONSTRAINT "SalesContact_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Deal" ADD CONSTRAINT "Deal_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Deal" ADD CONSTRAINT "Deal_assignedTo_fkey"
  FOREIGN KEY ("assignedTo") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
