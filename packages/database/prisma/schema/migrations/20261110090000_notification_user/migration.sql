-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "userId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "link" TEXT;

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
