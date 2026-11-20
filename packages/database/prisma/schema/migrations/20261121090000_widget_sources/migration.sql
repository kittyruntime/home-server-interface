-- CreateTable
CREATE TABLE "WidgetSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',
    "headers" TEXT NOT NULL DEFAULT '[]',
    "command" TEXT NOT NULL DEFAULT '',
    "intervalSec" INTEGER NOT NULL DEFAULT 60,
    "visibility" TEXT NOT NULL DEFAULT 'admins',
    "pushHash" TEXT,
    "trackPath" TEXT NOT NULL DEFAULT '',
    "alert" TEXT NOT NULL DEFAULT '',
    "lastValue" TEXT,
    "lastAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "allowSelfSigned" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "WidgetSourceSample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sourceId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value" REAL NOT NULL
);

-- CreateIndex
CREATE INDEX "WidgetSourceSample_sourceId_timestamp_idx" ON "WidgetSourceSample"("sourceId", "timestamp");

