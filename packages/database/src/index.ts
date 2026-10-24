import path from "node:path"
import { fileURLToPath } from "node:url"
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3"
import { PrismaClient } from "./generated/prisma/client"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const defaultUrl = `file:${path.join(packageDir, "data/hsi.db")}`

export function createPrismaClient(url = process.env.DATABASE_URL ?? defaultUrl): PrismaClient {
  if (!url.startsWith("file:") || !path.isAbsolute(url.slice(5))) {
    throw new Error("SQLite DATABASE_URL must be an absolute file: URL")
  }
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }
export const prisma = globalForPrisma.prisma ?? createPrismaClient()
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma

export { PrismaClient } from "./generated/prisma/client"
export { Prisma } from "./generated/prisma/client"
export type * from "./generated/prisma/client"
