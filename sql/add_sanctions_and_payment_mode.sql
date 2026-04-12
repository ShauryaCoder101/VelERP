-- =============================================
-- 1. Create PaymentMode enum type
-- =============================================
DO $$ BEGIN
    CREATE TYPE "PaymentMode" AS ENUM ('CREDIT_CARD', 'DEBIT_CARD', 'UPI', 'NOTA');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- =============================================
-- 2. Add paymentMode column to EventVendorFinance
--    Default to NOTA for existing & new rows
-- =============================================
ALTER TABLE "EventVendorFinance"
    ADD COLUMN IF NOT EXISTS "paymentMode" "PaymentMode" NOT NULL DEFAULT 'NOTA';

-- =============================================
-- 3. Create EventSanction table
-- =============================================
CREATE TABLE IF NOT EXISTS "EventSanction" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sanctionedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventSanction_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one sanction per user per event
ALTER TABLE "EventSanction"
    ADD CONSTRAINT "EventSanction_eventId_userId_key"
    UNIQUE ("eventId", "userId");

-- Foreign keys
ALTER TABLE "EventSanction"
    ADD CONSTRAINT "EventSanction_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EventSanction"
    ADD CONSTRAINT "EventSanction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
