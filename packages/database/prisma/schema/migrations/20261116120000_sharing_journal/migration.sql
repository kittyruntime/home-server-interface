-- CreateTable
CREATE TABLE "SmbSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "netbiosName" TEXT NOT NULL DEFAULT '',
    "workgroup" TEXT NOT NULL DEFAULT '',
    "minProtocol" TEXT NOT NULL DEFAULT 'SMB2',
    "encryption" TEXT NOT NULL DEFAULT 'off',
    "discoveryWsd" BOOLEAN NOT NULL DEFAULT false,
    "discoveryMdns" BOOLEAN NOT NULL DEFAULT false,
    "autoBlock" BOOLEAN NOT NULL DEFAULT true,
    "blockThreshold" INTEGER NOT NULL DEFAULT 10,
    "blockWindowMin" INTEGER NOT NULL DEFAULT 10,
    "blockForMin" INTEGER NOT NULL DEFAULT 30,
    "eventCursor" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShareEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "user" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "machine" TEXT NOT NULL DEFAULT '',
    "share" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "SmbBlock" (
    "ip" TEXT NOT NULL PRIMARY KEY,
    "until" DATETIME NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'auto',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AlterTable
ALTER TABLE "Share" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ShareEvent_at_idx" ON "ShareEvent"("at");

-- CreateIndex
CREATE INDEX "ShareEvent_user_at_idx" ON "ShareEvent"("user", "at");

-- CreateIndex
CREATE INDEX "ShareEvent_share_at_idx" ON "ShareEvent"("share", "at");

-- CreateIndex
CREATE INDEX "ShareEvent_ip_at_idx" ON "ShareEvent"("ip", "at");

