// Source installs have no versioned release to hand to #9a's root worker.
// Restore their staged Compose targets on installer failure. Release installs
// use the worker snapshot instead.
import { createHash, randomUUID } from "node:crypto"
import { readFile, lstat, open, rename, rm } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { STACK_NAME_RE } from "../../../compose/src/index"

const stageDir = process.env.HSI_CONTAINERS_STAGE
const stacksDir = process.env.HSI_CONTAINERS_DIR ?? "/opt/containers"
if (!stageDir || !path.isAbsolute(stageDir) || !path.isAbsolute(stacksDir)) throw new Error("absolute Compose stage and live paths required")
type Entry = { name: string; operation: "create" | "replace"; originalSha256: string | null; stagedSha256: string }
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex")
const manifest = JSON.parse(await readFile(path.join(stageDir, "manifest.json"), "utf8")) as { entries: Entry[] }
if (!Array.isArray(manifest.entries)) throw new Error("invalid Compose stage manifest")
for (const entry of manifest.entries) {
  if (!STACK_NAME_RE.test(entry.name)) throw new Error(`invalid Compose app name ${entry.name}`)
  const filename = path.join(stacksDir, entry.name, "compose.yaml")
  try {
    const stat = await lstat(filename)
    if (!stat.isFile()) throw new Error(`Compose target is not a file: ${filename}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
    throw error
  }
  const live = await readFile(filename)
  if (hash(live) !== entry.stagedSha256) {
    if (entry.operation === "replace" && hash(live) === entry.originalSha256) continue
    throw new Error(`Compose target changed during rollback: ${filename}`)
  }
  if (entry.operation === "create") {
    await rm(filename)
  } else if (entry.operation === "replace") {
    const original = await readFile(path.join(stageDir, "original", entry.name, "compose.yaml"))
    if (hash(original) !== entry.originalSha256) throw new Error(`original Compose checksum mismatch: ${entry.name}`)
    const tmp = path.join(stacksDir, entry.name, `.compose-restore-${randomUUID()}`)
    try {
      const fd = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try { await fd.writeFile(original); await fd.sync() } finally { await fd.close() }
      await rename(tmp, filename)
    } finally { await rm(tmp, { force: true }) }
  } else throw new Error(`invalid Compose operation: ${entry.operation}`)
}
