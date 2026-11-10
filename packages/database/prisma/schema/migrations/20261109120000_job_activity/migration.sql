-- AlterTable
ALTER TABLE "Job" ADD COLUMN "meta" TEXT;
ALTER TABLE "Job" ADD COLUMN "startedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "finishedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "cancelledAt" DATETIME;

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_userId_createdAt_idx" ON "Job"("userId", "createdAt");
