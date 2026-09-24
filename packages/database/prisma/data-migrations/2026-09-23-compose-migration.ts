// One-time migration: ContainerApp/ContainerNetwork/ContainerVolume rows ->
// /opt/containers/<name>/compose.yaml files (the new source of truth). Runs
// BEFORE `prisma db push`, which then drops the tables. Idempotent: skips
// apps whose compose.yaml already exists (hand-created files win).
//
// Reads rows through raw SQL on purpose: install.sh regenerates @prisma/client
// from the NEW schema before running this script, so the generated client no
// longer exposes the ContainerApp models at migration time. $queryRawUnsafe
// works with any client version against the still-present tables.
//
// Run (prod):  handled by scripts/install.sh (data-migrations loop, runs as the
//              app user - /opt/containers must exist and be writable by it).
// Test (copy): DATABASE_URL="file:/abs/copy.db" HSI_CONTAINERS_DIR=/tmp/stacks \
//              pnpm --filter @app/database exec vite-node prisma/data-migrations/2026-09-23-compose-migration.ts
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { PrismaClient } from "@prisma/client"
import { generateComposeYaml, type AppInput } from "@app/compose"

const url = process.env.DATABASE_URL
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient()
const stacksDir = process.env.HSI_CONTAINERS_DIR ?? "/opt/containers"

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name)
  return rows.length > 0
}

function dec<T>(s: unknown, fallback: T): T {
  if (s == null) return fallback
  try { return JSON.parse(String(s)) as T } catch { return fallback }
}

interface LegacyRow {
  name: string; image: string
  ports: string; envs: string; volumes: string
  networkNames: string; labels: string
  capAdd: string; capDrop: string; extraHosts: string
  restartPolicy: string
  hostname: string | null; user: string | null; command: string | null
  cpuLimit: number | null; memoryLimit: string | null; pinnedUrl: string | null
}

async function main() {
  if (!(await tableExists("ContainerApp"))) { console.log("no ContainerApp table - nothing to migrate"); return }
  await mkdir(stacksDir, { recursive: true })

  const rows = await prisma.$queryRawUnsafe<LegacyRow[]>(
    `SELECT "name","image","ports","envs","volumes","networkNames","labels",
            "capAdd","capDrop","extraHosts","restartPolicy","hostname","user",
            "command","cpuLimit","memoryLimit","pinnedUrl"
     FROM "ContainerApp" ORDER BY "createdAt"`)
  let written = 0, skipped = 0
  for (const row of rows) {
    const composePath = path.join(stacksDir, row.name, "compose.yaml")
    // Skip when the file already exists (hand-created wins).
    try { await readFile(composePath, "utf8"); skipped++; continue } catch { /* not there - generate */ }

    const resolved: AppInput["volumes"] = []
    for (const v of dec<Array<{ type: string; source: string; target: string; readOnly: boolean }>>(row.volumes, [])) {
      if (v.type === "place") {
        const places = await prisma.$queryRawUnsafe<Array<{ path: string }>[]>(
          `SELECT "path" FROM "Place" WHERE "id"=?`, v.source)
        const p = places[0]?.[0]
        if (!p) { console.warn(`app ${row.name}: place ${v.source} missing - volume skipped`); continue }
        resolved.push({ type: "bind", source: p.path, target: v.target, readOnly: v.readOnly })
      } else {
        resolved.push(v as AppInput["volumes"][number])
      }
    }

    const input: AppInput = {
      name: row.name, image: row.image,
      ports: dec(row.ports, []), envs: dec(row.envs, []), volumes: resolved,
      networkNames: dec(row.networkNames, []), labels: dec(row.labels, []),
      capAdd: dec(row.capAdd, []), capDrop: dec(row.capDrop, []), extraHosts: dec(row.extraHosts, []),
      restartPolicy: row.restartPolicy, hostname: row.hostname, user: row.user, command: row.command,
      cpuLimit: row.cpuLimit, memoryLimit: row.memoryLimit, pinnedUrl: row.pinnedUrl,
    }
    const yaml = generateComposeYaml(input) // named volumes auto-declared by compose
    await mkdir(path.join(stacksDir, row.name), { recursive: true })
    await writeFile(composePath, yaml, "utf8")
    written++
  }
  console.log(`compose migration: ${written} written, ${skipped} skipped (file already present)`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
