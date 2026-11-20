-- CreateTable
CREATE TABLE "DashboardWall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "widgets" TEXT NOT NULL DEFAULT '[]',
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DashboardWall_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DashboardWall_tokenHash_key" ON "DashboardWall"("tokenHash");

-- CreateIndex
CREATE INDEX "DashboardWall_ownerId_idx" ON "DashboardWall"("ownerId");

