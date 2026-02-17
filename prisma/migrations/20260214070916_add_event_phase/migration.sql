/*
  Warnings:

  - You are about to drop the column `status` on the `Event` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "Phase" AS ENUM ('IDEATION', 'PITCHING', 'BIDDING', 'PREPARATION', 'ONGOING', 'FINISHED');

-- AlterTable
ALTER TABLE "Event" DROP COLUMN "status",
ADD COLUMN     "phase" "Phase" NOT NULL DEFAULT 'IDEATION';

-- CreateTable
CREATE TABLE "EventArtist" (
    "eventId" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,

    CONSTRAINT "EventArtist_pkey" PRIMARY KEY ("eventId","artistId")
);

-- AddForeignKey
ALTER TABLE "EventArtist" ADD CONSTRAINT "EventArtist_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventArtist" ADD CONSTRAINT "EventArtist_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
