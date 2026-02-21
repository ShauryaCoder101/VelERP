/*
  Warnings:

  - The values [ACCOUNTANT,PHOTOGRAPHER] on the enum `RoleName` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `clientCost` on the `Event` table. All the data in the column will be lost.
  - You are about to drop the column `internalCost` on the `Event` table. All the data in the column will be lost.
  - You are about to drop the column `velocityRep` on the `Event` table. All the data in the column will be lost.
  - The `status` column on the `ExpenseClaim` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `email` on the `Vendor` table. All the data in the column will be lost.
  - You are about to drop the `EventBill` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "RoleName_new" AS ENUM ('MANAGING_DIRECTOR', 'HEAD_OF_OPERATIONS', 'HEAD_OF_SPECIAL_PROJECTS', 'GROWTH_PARTNER', 'OPERATIONS_TEAM_MEMBER', 'RESEARCH_AND_DEVELOPMENT_TEAM_MEMBER', 'INTERN', 'ASSISTANT', 'FREELANCER', 'ACCOUNTANT', 'PHOTOGRAPHER');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "RoleName_new" USING ("role"::text::"RoleName_new");
ALTER TYPE "RoleName" RENAME TO "RoleName_old";
ALTER TYPE "RoleName_new" RENAME TO "RoleName";
DROP TYPE "public"."RoleName_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "EventBill" DROP CONSTRAINT "EventBill_eventId_fkey";

-- DropForeignKey
ALTER TABLE "EventBill" DROP CONSTRAINT "EventBill_vendorId_fkey";

-- AlterTable
ALTER TABLE "Event" DROP COLUMN "clientCost",
DROP COLUMN "internalCost",
DROP COLUMN "velocityRep";

-- AlterTable
ALTER TABLE "ExpenseClaim" DROP COLUMN "status",
ADD COLUMN     "status" "Status" NOT NULL DEFAULT 'INACTIVE';

-- AlterTable
ALTER TABLE "Vendor" DROP COLUMN "email";

-- DropTable
DROP TABLE "EventBill";

-- DropEnum
DROP TYPE "ClaimStatus";
