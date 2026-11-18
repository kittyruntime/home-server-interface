-- AlterTable
ALTER TABLE "Share" ADD COLUMN "timeMachine" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Share" ADD COLUMN "timeMachineMaxGb" INTEGER;
