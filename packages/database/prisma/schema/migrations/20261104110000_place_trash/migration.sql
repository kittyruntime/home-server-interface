-- AlterTable
ALTER TABLE "Place" ADD COLUMN "trashEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Place" ADD COLUMN "trashRetentionDays" INTEGER;
