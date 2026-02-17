/*
  Warnings:

  - The `status` column on the `ExpenseClaim` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('INCOMPLETE', 'FLAGGED', 'DONE');

-- AlterEnum
ALTER TYPE "RoleName" ADD VALUE 'PHOTOGRAPHER';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "clientCost" DOUBLE PRECISION,
ADD COLUMN     "internalCost" DOUBLE PRECISION,
ADD COLUMN     "velocityRep" TEXT;

-- AlterTable
ALTER TABLE "ExpenseClaim" DROP COLUMN "status",
ADD COLUMN     "status" "ClaimStatus" NOT NULL DEFAULT 'INCOMPLETE';

-- CreateTable
CREATE TABLE "EventBill" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorGstin" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "work" TEXT NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventBill_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EventBill" ADD CONSTRAINT "EventBill_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventBill" ADD CONSTRAINT "EventBill_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
