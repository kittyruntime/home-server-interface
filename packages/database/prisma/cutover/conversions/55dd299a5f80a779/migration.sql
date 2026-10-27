-- DropIndex
DROP INDEX "ContainerApp_name_key";

-- DropIndex
DROP INDEX "ContainerNetwork_name_key";

-- DropIndex
DROP INDEX "ContainerVolume_name_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ContainerApp";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ContainerNetwork";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ContainerVolume";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "AlertThreshold" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "diskUsageWarningPercent" INTEGER NOT NULL DEFAULT 80,
    "diskUsageCriticalPercent" INTEGER NOT NULL DEFAULT 90
);

-- CreateTable
CREATE TABLE "BackupPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "remoteHost" TEXT,
    "remoteUser" TEXT,
    "remotePort" INTEGER NOT NULL DEFAULT 22,
    "sshKeyPath" TEXT,
    "schedule" TEXT NOT NULL DEFAULT 'manual',
    "scheduleHour" INTEGER NOT NULL DEFAULT 2,
    "scheduleMinute" INTEGER NOT NULL DEFAULT 0,
    "scheduleWeekday" INTEGER NOT NULL DEFAULT 0,
    "deleteExtra" BOOLEAN NOT NULL DEFAULT false,
    "compress" BOOLEAN NOT NULL DEFAULT true,
    "bandwidthLimit" INTEGER,
    "excludes" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastJobId" TEXT,
    "lastStatus" TEXT,
    "lastRunAt" DATETIME,
    "lastError" TEXT,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DiskLabel" (
    "serial" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NotificationConnector" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "url" TEXT NOT NULL DEFAULT '',
    "headers" TEXT NOT NULL DEFAULT '{}',
    "bodyTemplate" TEXT NOT NULL DEFAULT '',
    "config" TEXT NOT NULL DEFAULT '{}',
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "NotificationRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sourcePrefix" TEXT NOT NULL DEFAULT '',
    "minSeverity" TEXT NOT NULL DEFAULT 'warning',
    "connectorIds" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "severity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'legacy',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" TEXT NOT NULL DEFAULT '{}',
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT DEFAULT '',
    "test" BOOLEAN NOT NULL DEFAULT false,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME
);

-- CreateTable
CREATE TABLE "SetupState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "step" TEXT NOT NULL DEFAULT 'admin',
    "skipped" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "VolumeHold" (
    "mountPoint" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "since" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedApps" TEXT NOT NULL DEFAULT '[]',
    "strayFiles" BOOLEAN NOT NULL DEFAULT false
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL
);
INSERT INTO "new_Alert" ("firstSeenAt", "id", "lastSeenAt", "message", "source", "target") SELECT "firstSeenAt", "id", "lastSeenAt", "message", "source", "target" FROM "Alert";
DROP TABLE "Alert";
ALTER TABLE "new_Alert" RENAME TO "Alert";
CREATE UNIQUE INDEX "Alert_source_target_key" ON "Alert"("source", "target");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "displayName" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isUserManager" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "sambaEnabled" BOOLEAN NOT NULL DEFAULT true,
    "wallpaper" JSONB,
    "preferences" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("createdAt", "displayName", "id", "isAdmin", "isUserManager", "password", "preferences", "updatedAt", "username", "wallpaper") SELECT "createdAt", "displayName", "id", "isAdmin", "isUserManager", "password", "preferences", "updatedAt", "username", "wallpaper" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "NotificationConnector_name_key" ON "NotificationConnector"("name");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");
