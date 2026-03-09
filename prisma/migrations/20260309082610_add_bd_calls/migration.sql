-- CreateEnum
CREATE TYPE "BdStatus" AS ENUM ('FOLLOWUP', 'LEAD', 'DORMANT', 'ACTIVE');

-- CreateTable
CREATE TABLE "BdCall" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "pocName" TEXT NOT NULL,
    "pocPhone" TEXT NOT NULL,
    "callDate" TIMESTAMP(3) NOT NULL,
    "status" "BdStatus" NOT NULL DEFAULT 'ACTIVE',
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BdCall_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BdCall" ADD CONSTRAINT "BdCall_addedBy_fkey" FOREIGN KEY ("addedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
