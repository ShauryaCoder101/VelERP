-- AlterEnum
ALTER TYPE "RoleName" ADD VALUE 'ACCOUNTANT';

-- AlterTable
ALTER TABLE "Artist" ADD COLUMN     "location" TEXT,
ADD COLUMN     "socialLink" TEXT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "email" TEXT,
ADD COLUMN     "location" TEXT;
