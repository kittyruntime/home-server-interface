// Activate files staged by compose-staging.ts after snapshot-compose has saved
// every target. The original and staged checksums prevent a stale stage from
// overwriting files changed since staging.
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, lstat, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { STACK_NAME_RE } from "../../../compose/src/index"
import { reportCutoverError } from "./error"

const stacksDir = process.env.HSI_CONTAINERS_DIR ?? "/opt/containers"
const stageDir = process.env.HSI_CONTAINERS_STAGE

type Entry = { name: string; operation: "create" | "replace"; originalSha256: string | null; stagedSha256: string }
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

async function regularFile(filename: string): Promise<Buffer | null> {
  try {
    const stat = await lstat(filename)
    if (!stat.isFile()) throw new Error(`${filename} is not a regular file`)
    const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { return await fd.readFile() } finally { await fd.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

try {
if (!path.isAbsolute(stacksDir) || !stageDir || !path.isAbsolute(stageDir)) throw new Error("absolute HSI_CONTAINERS_DIR and HSI_CONTAINERS_STAGE required")
const manifest = JSON.parse(await readFile(path.join(stageDir, "manifest.json"), "utf8")) as { entries: Entry[] }
if (!Array.isArray(manifest.entries)) throw new Error("invalid Compose stage manifest")
const seen = new Set<string>()
for (const entry of manifest.entries) {
  if (!STACK_NAME_RE.test(entry.name) || seen.has(entry.name)) throw new Error(`invalid or duplicate app name ${entry.name}`)
  seen.add(entry.name)
  const stagedPath = path.join(stageDir, entry.name, "compose.yaml")
  const staged = await regularFile(stagedPath)
  if (!staged || sha(staged) !== entry.stagedSha256) throw new Error(`staged Compose checksum changed: ${entry.name}`)
  const appDir = path.join(stacksDir, entry.name)
  try {
    const stat = await lstat(appDir)
    if (!stat.isDirectory()) throw new Error(`${appDir} is not a real directory`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || entry.operation !== "create") throw error
    await mkdir(appDir, { mode: 0o755 })
  }
  const livePath = path.join(appDir, "compose.yaml")
  const live = await regularFile(livePath)
  if (entry.operation === "create" ? live !== null || entry.originalSha256 !== null : live === null || sha(live) !== entry.originalSha256) {
    throw new Error(`live Compose file changed since staging: ${entry.name}`)
  }
  const tempPath = path.join(appDir, `.compose-hsi-${randomUUID()}`)
  try {
    const fd = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await fd.writeFile(staged); await fd.sync() } finally { await fd.close() }
    await rename(tempPath, livePath)
  } finally { await rm(tempPath, { force: true }) }
}
console.log(`activated ${manifest.entries.length} staged Compose files`)

} catch (error) { reportCutoverError(error) }
