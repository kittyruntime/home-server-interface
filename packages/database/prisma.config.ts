import { fileURLToPath } from "node:url"
import path from "node:path"
import { defineConfig } from "prisma/config"

const packageDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  schema: path.join(packageDir, "prisma/schema"),
  migrations: {
    path: path.join(packageDir, "prisma/schema/migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? `file:${path.join(packageDir, "data/hsi.db")}`,
  },
})
