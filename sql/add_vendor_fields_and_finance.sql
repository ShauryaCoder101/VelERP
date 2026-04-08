-- =============================================
-- 1. Add new columns to Vendor table
-- =============================================
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "panCard" TEXT;
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "pocName" TEXT;

-- =============================================
-- 2. Create EventVendorFinance table
-- =============================================
CREATE TABLE IF NOT EXISTS "EventVendorFinance" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "eventId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "quotedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "advancePaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventVendorFinance_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one finance record per vendor per event
ALTER TABLE "EventVendorFinance" 
    ADD CONSTRAINT "EventVendorFinance_eventId_vendorId_key" 
    UNIQUE ("eventId", "vendorId");

-- Foreign keys
ALTER TABLE "EventVendorFinance" 
    ADD CONSTRAINT "EventVendorFinance_eventId_fkey" 
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EventVendorFinance" 
    ADD CONSTRAINT "EventVendorFinance_vendorId_fkey" 
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
