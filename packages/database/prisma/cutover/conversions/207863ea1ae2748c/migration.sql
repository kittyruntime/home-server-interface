-- CreateTable
CREATE TABLE "SetupState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "step" TEXT NOT NULL DEFAULT 'admin',
    "skipped" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);
