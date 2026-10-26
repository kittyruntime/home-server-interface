// Stage historical ContainerApp rows as Compose files, and stage named-volume
// repairs. This command never changes /opt/containers; the installer applies the
// staged manifest only after #9a snapshot and DB conversion have succeeded.
import { mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { createPrismaClient } from "../../src/index"
import { generateComposeYaml, repairNamedVolumeDeclarations, STACK_NAME_RE, type AppInput } from "../../../compose/src/index"

const prisma = createPrismaClient()
const stacksDir = process.env.HSI_CONTAINERS_DIR ?? "/opt/containers"
const stageDir = process.env.HSI_CONTAINERS_STAGE
if (!stageDir || !path.isAbsolute(stageDir)) throw new Error("HSI_CONTAINERS_STAGE must be an absolute path")

type Entry = { name: string; operation: "create" | "replace"; originalSha256: string | null; stagedSha256: string }
const entries: Entry[] = []
function sha256(text: string) { return createHash("sha256").update(text).digest("hex") }
async function stage(name: string, operation: Entry["operation"], original: string | null, content: string) {
  if (!STACK_NAME_RE.test(name)) throw new Error(`unsafe container app name: ${name}`)
  const dir = path.join(stageDir!, name)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(path.join(dir, "compose.yaml"), content, { mode: 0o600 })
  if (original !== null) {
    const originalDir = path.join(stageDir!, "original", name)
    await mkdir(originalDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(originalDir, "compose.yaml"), original, { mode: 0o600 })
  }
  entries.push({ name, operation, originalSha256: original === null ? null : sha256(original), stagedSha256: sha256(content) })
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name)
  return rows.length > 0
}

function dec<T>(s: unknown, fallback: T): T {
  if (s == null) return fallback
  try { return JSON.parse(String(s)) as T } catch { throw new Error(`invalid historical ContainerApp JSON: ${String(s).slice(0, 80)}`) }
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
  await mkdir(stageDir!, { recursive: true, mode: 0o700 })
  const rows = (await tableExists("ContainerApp")) ? await prisma.$queryRawUnsafe<LegacyRow[]>(
    `SELECT "name","image","ports","envs","volumes","networkNames","labels",
            "capAdd","capDrop","extraHosts","restartPolicy","hostname","user",
            "command","cpuLimit","memoryLimit","pinnedUrl"
     FROM "ContainerApp" ORDER BY "createdAt"`) : []
  let written = 0, skipped = 0
  for (const row of rows) {
    if (!STACK_NAME_RE.test(row.name)) throw new Error(`unsafe container app name: ${row.name}`)
    const appDir = path.join(stacksDir, row.name)
    try {
      if (!(await lstat(appDir)).isDirectory()) throw new Error(`container app path is not a real directory: ${appDir}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const composePath = path.join(stacksDir, row.name, "compose.yaml")
    // Existing hand-created Compose files remain authoritative.
    try {
      if (!(await lstat(composePath)).isFile()) throw new Error(`Compose path is not a regular file: ${composePath}`)
      await readFile(composePath, "utf8")
      skipped++
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    const resolved: AppInput["volumes"] = []
    for (const v of dec<Array<{ type: string; source: string; target: string; readOnly: boolean }>>(row.volumes, [])) {
      if (v.type === "place") {
        // $queryRawUnsafe returns the rows as a flat array of objects
        // ([{ path }]), not an array of arrays.
        const places = await prisma.$queryRawUnsafe<Array<{ path: string }>>(
          `SELECT "path" FROM "Place" WHERE "id"=?`, v.source)
        const p = places[0]?.path
        if (!p) throw new Error(`app ${row.name}: referenced place ${v.source} is missing`)
        resolved.push({ type: "bind", source: p, target: v.target, readOnly: v.readOnly })
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
    const yaml = generateComposeYaml(input) // declares named volumes at the top level
    await stage(row.name, "create", null, yaml)
    written++
  }
  // v1.53/v1.54 files may lack top-level declarations for named volumes.
  // Stage only files that actually need repair; avoid following symlinked dirs.
  let repaired = 0
  for (const name of await readdir(stacksDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[]
    throw error
  })) {
    if (!STACK_NAME_RE.test(name)) continue
    const appDir = path.join(stacksDir, name)
    if (!(await lstat(appDir)).isDirectory()) continue
    const composePath = path.join(appDir, "compose.yaml")
    let original: string
    try {
      if (!(await lstat(composePath)).isFile()) continue
      original = await readFile(composePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    const fixed = repairNamedVolumeDeclarations(original)
    if (fixed !== null) { await stage(name, "replace", original, fixed); repaired++ }
  }
  await writeFile(path.join(stageDir!, "manifest.json"), JSON.stringify({ entries }, null, 2) + "\n", { mode: 0o600 })
  console.log(`compose cutover staged: ${written} new, ${repaired} repaired, ${skipped} existing`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
