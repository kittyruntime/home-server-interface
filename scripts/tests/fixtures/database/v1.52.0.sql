-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AlertThreshold" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "diskUsageWarningPercent" INTEGER NOT NULL DEFAULT 80,
    "diskUsageCriticalPercent" INTEGER NOT NULL DEFAULT 90
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "meta" TEXT,
    "ip" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
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
CREATE TABLE "ContainerApp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "ports" TEXT NOT NULL DEFAULT '[]',
    "envs" TEXT NOT NULL DEFAULT '[]',
    "volumes" TEXT NOT NULL DEFAULT '[]',
    "networkNames" TEXT NOT NULL DEFAULT '[]',
    "labels" TEXT NOT NULL DEFAULT '[]',
    "capAdd" TEXT NOT NULL DEFAULT '[]',
    "capDrop" TEXT NOT NULL DEFAULT '[]',
    "extraHosts" TEXT NOT NULL DEFAULT '[]',
    "restartPolicy" TEXT NOT NULL DEFAULT 'no',
    "hostname" TEXT,
    "user" TEXT,
    "command" TEXT,
    "cpuLimit" REAL,
    "memoryLimit" TEXT,
    "pinnedUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ContainerNetwork" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'bridge',
    "subnet" TEXT,
    "gateway" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ContainerVolume" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "volumeType" TEXT NOT NULL DEFAULT 'named',
    "sourcePath" TEXT,
    "placeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserGroup" (
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    PRIMARY KEY ("userId", "groupId"),
    CONSTRAINT "UserGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "result" TEXT,
    "error" TEXT,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuPct" REAL NOT NULL,
    "ramUsed" BIGINT NOT NULL,
    "ramTotal" BIGINT NOT NULL,
    "netRxBps" BIGINT NOT NULL,
    "netTxBps" BIGINT NOT NULL,
    "uptime" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "GroupPlacePermission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "canShare" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "GroupPlacePermission_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupPlacePermission_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserPlacePermission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "canShare" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "UserPlacePermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserPlacePermission_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Share" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "placeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "smbName" TEXT,
    "guestOk" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Share_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "isDir" BOOLEAN NOT NULL,
    "creatorId" TEXT NOT NULL,
    "passwordHash" TEXT,
    "expiresAt" DATETIME,
    "maxDownloads" INTEGER,
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessAt" DATETIME,
    CONSTRAINT "ShareLink_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "displayName" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isUserManager" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "wallpaper" JSONB,
    "preferences" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UserCapability" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserCapability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Alert_source_target_key" ON "Alert"("source", "target");

-- CreateIndex
CREATE UNIQUE INDEX "ContainerApp_name_key" ON "ContainerApp"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ContainerNetwork_name_key" ON "ContainerNetwork"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ContainerVolume_name_key" ON "ContainerVolume"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Group_name_key" ON "Group"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GroupPlacePermission_groupId_placeId_key" ON "GroupPlacePermission"("groupId", "placeId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPlacePermission_userId_placeId_key" ON "UserPlacePermission"("userId", "placeId");

-- CreateIndex
CREATE UNIQUE INDEX "Place_path_key" ON "Place"("path");

-- CreateIndex
CREATE UNIQUE INDEX "Share_placeId_key" ON "Share"("placeId");

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_token_key" ON "ShareLink"("token");

-- CreateIndex
CREATE INDEX "ShareLink_creatorId_idx" ON "ShareLink"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "UserCapability_userId_capability_key" ON "UserCapability"("userId", "capability");
