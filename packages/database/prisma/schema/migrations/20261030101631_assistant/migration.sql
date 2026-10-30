-- CreateTable
CREATE TABLE "AssistantSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'openrouter',
    "baseUrl" TEXT NOT NULL DEFAULT 'https://openrouter.ai/api/v1',
    "apiKey" TEXT,
    "model" TEXT NOT NULL DEFAULT '',
    "access" TEXT NOT NULL DEFAULT 'admins',
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "dailyTokenLimit" INTEGER,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AssistantConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AssistantConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AssistantMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "toolCalls" TEXT,
    "toolCallId" TEXT,
    "toolName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AssistantUsage" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("userId", "day"),
    CONSTRAINT "AssistantUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT,
    "conversationId" TEXT,
    "tool" TEXT NOT NULL,
    "reason" TEXT,
    "procedure" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "destructive" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "decidedAt" DATETIME,
    CONSTRAINT "AgentAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentAction" ("createdAt", "decidedAt", "destructive", "error", "expiresAt", "id", "input", "preview", "procedure", "reason", "result", "status", "title", "tokenId", "tool", "userId") SELECT "createdAt", "decidedAt", "destructive", "error", "expiresAt", "id", "input", "preview", "procedure", "reason", "result", "status", "title", "tokenId", "tool", "userId" FROM "AgentAction";
DROP TABLE "AgentAction";
ALTER TABLE "new_AgentAction" RENAME TO "AgentAction";
CREATE INDEX "AgentAction_userId_status_idx" ON "AgentAction"("userId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AssistantConversation_userId_updatedAt_idx" ON "AssistantConversation"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AssistantMessage_conversationId_createdAt_idx" ON "AssistantMessage"("conversationId", "createdAt");
