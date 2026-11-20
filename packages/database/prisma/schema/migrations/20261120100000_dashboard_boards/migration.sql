-- CreateTable
CREATE TABLE "DashboardBoard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "widgets" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DashboardBoard_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VolumeUsageSample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "volumeId" TEXT NOT NULL,
    "used" BIGINT NOT NULL,
    "total" BIGINT NOT NULL
);

-- CreateIndex
CREATE INDEX "DashboardBoard_ownerId_idx" ON "DashboardBoard"("ownerId");

-- CreateIndex
CREATE INDEX "VolumeUsageSample_volumeId_timestamp_idx" ON "VolumeUsageSample"("volumeId", "timestamp");

