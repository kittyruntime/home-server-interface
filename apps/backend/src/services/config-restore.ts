import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { decryptToFile } from "./config-backup"

// Restoring a configuration backup (#1): a preview first (what the backup
// holds, what conflicts, what to know), kept for 15 minutes under a token,
// then the restore itself. The worker unpacks, checks and applies the system
// part; the database is swapped last, so a failure before leaves it untouched.

export interface RestoreDeps {
  stagingRoot(): Promise<string>
  worker(subject: string, payload: Record<string, unknown>): Promise<unknown>
  validateDb(file: string): Promise<void>
  countRestored(file: string): Promise<{ users: number; admins?: number; groups: number; places: number; shares: number; connectors: number; placePaths: string[] }>
  pathExists(p: string): Promise<boolean>
  currentVersion(): string
  currentSecretsKey(): string | undefined
  envPath(): string
  swapDatabase(file: string, userId: string, ip: string): Promise<unknown>
  now(): number
}

export type Conflict = { kind: string; name: string; detail: string; command: string }
export type RestorePreview = {
  token: string
  format: 1 | 2
  backup: { hsiVersion?: string; createdAt?: string; hostname?: string }
  contents: { users: number; groups: number; places: number; shares: number; connectors: number; apps: string[]; volumes: number }
  conflicts: Conflict[]
  warnings: string[]
}

type Manifest = { format: number; hsiVersion?: string; createdAt?: string; hostname?: string }
type Check = { conflicts: Conflict[]; apps: Array<{ name: string; state: string }>; volumes: Array<{ mountPoint: string; disksPresent: number; disksMissing: number }> }

const PREVIEW_TTL_MS = 15 * 60_000
const pending = new Map<string, { dir: string; format: 1 | 2; database: string; expiresAt: number; blocked: boolean }>()

/**
 * Who may restore: an admin, or the first-run assistant (#12) with its setup
 * session while no administrator exists yet. Null when neither.
 */
export function restoreCaller(c: { adminUserId: string | null; setupSession: boolean; adminCount: number }): { userId: string; setup: boolean } | null {
  if (c.adminUserId) return { userId: c.adminUserId, setup: false }
  if (c.setupSession && c.adminCount === 0) return { userId: "", setup: true }
  return null
}

/** Compares two versions (major.minor.patch, leading v optional). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[+-]/)[0]!.split(".").map(n => Number.parseInt(n, 10) || 0)
  const x = parts(a), y = parts(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Removes a preview and its decrypted files at once (Cancel). */
export async function cancelConfigRestore(token: string) {
  const p = pending.get(token)
  if (!p) return
  pending.delete(token)
  await rm(p.dir, { recursive: true, force: true })
}

/**
 * Removes the staged previews and exports left by an earlier run of the
 * backend: the in-memory list of previews does not survive a restart.
 */
export async function purgeStaging(root: string) {
  const { readdir } = await import("node:fs/promises")
  const known = new Set([...pending.values()].map(p => path.basename(p.dir)))
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if ((name.startsWith("restore-") || name.startsWith("export-")) && !known.has(name)) {
      await rm(path.join(root, name), { recursive: true, force: true })
    }
  }
}

/** Drops previews older than 15 minutes, with their decrypted files. */
export async function sweepRestores(d: Pick<RestoreDeps, "now">) {
  for (const [token, p] of pending) {
    if (p.expiresAt <= d.now()) {
      pending.delete(token)
      await rm(p.dir, { recursive: true, force: true })
    }
  }
}

export async function previewConfigRestore(encrypted: string, password: string, d: RestoreDeps): Promise<RestorePreview> {
  await sweepRestores(d)
  const dir = await mkdtemp(path.join(await d.stagingRoot(), "restore-"))
  try {
    const plain = path.join(dir, "plain")
    const format = await decryptToFile(encrypted, password, plain)
    let database = plain
    let manifest: Manifest = { format: 1 }
    let check: Check = { conflicts: [], apps: [], volumes: [] }
    if (format === 2) {
      const dest = path.join(dir, "archive")
      manifest = await d.worker("root.config.unpack", { tar: plain, dest, ownerUid: process.getuid?.() ?? 0 }) as Manifest
      await rm(plain, { force: true })
      if (manifest.hsiVersion && compareVersions(manifest.hsiVersion, d.currentVersion()) > 0) {
        throw new Error(`This backup was made by HSI ${manifest.hsiVersion}, newer than this server (${d.currentVersion()}): update HSI first`)
      }
      database = path.join(dest, "database.db")
      check = await d.worker("root.config.check", { dir: dest }) as Check
    }
    await d.validateDb(database)
    const counts = await d.countRestored(database)
    // Restoring it would leave no way to sign in.
    if (counts.admins === 0) throw new Error("This backup has no administrator account: it cannot be restored")

    const warnings: string[] = []
    for (const a of check.apps) {
      if (a.state === "different") warnings.push(`The app ${a.name} exists here with other files: they are kept aside and replaced by the backup's.`)
    }
    for (const v of check.volumes) {
      if (v.disksPresent === 0) warnings.push(`The disks of the volume ${v.mountPoint} are not connected: it comes back once they are, with Reapply on the Volumes page.`)
      else if (v.disksMissing > 0) warnings.push(`${v.disksMissing} disk(s) of the volume ${v.mountPoint} are not connected.`)
    }
    for (const p of counts.placePaths) {
      if (!await d.pathExists(p)) warnings.push(`The folder of the Place ${p} does not exist yet (its volume may need to be brought back first).`)
    }
    if (format === 1) warnings.push("This backup holds the database only (made before HSI 1.65): accounts, apps and volume descriptions are not in it.")

    const token = randomUUID()
    pending.set(token, { dir, format, database, expiresAt: d.now() + PREVIEW_TTL_MS, blocked: check.conflicts.length > 0 })
    return {
      token,
      format,
      backup: { hsiVersion: manifest.hsiVersion, createdAt: manifest.createdAt, hostname: manifest.hostname },
      contents: { users: counts.users, groups: counts.groups, places: counts.places, shares: counts.shares, connectors: counts.connectors,
        apps: check.apps.map(a => a.name), volumes: check.volumes.length },
      conflicts: check.conflicts,
      warnings,
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function applyConfigRestore(token: string, userId: string, ip: string, d: RestoreDeps) {
  await sweepRestores(d)
  const p = pending.get(token)
  if (!p) throw new Error("This restore preview expired or is unknown: check the backup again")
  pending.delete(token)
  try {
    if (p.blocked) throw new Error("This backup has account conflicts: resolve them on the server, then check it again")
    let keptEnv: string | null = null
    if (p.format === 2) {
      const dest = path.dirname(p.database)
      // Read before anything is applied: an unreadable secrets file stops here.
      let key: string | undefined
      try {
        const raw = await readFile(path.join(dest, "secrets.json"), "utf8").catch(() => "{}")
        key = (JSON.parse(raw) as { HSI_SECRETS_KEY?: string }).HSI_SECRETS_KEY?.trim()
      } catch {
        throw new Error("The secrets file of this backup cannot be read")
      }
      if (key && !/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("The secrets key of this backup is not valid")
      // The worker checks the conflicts again: an account created since the
      // preview blocks the restore too.
      await d.worker("root.config.apply", { dir: dest })
      if (key && key !== d.currentSecretsKey()) {
        keptEnv = (await d.worker("root.config.secretsKey", { key }) as { backup?: string }).backup ?? null
      }
    }
    try {
      await d.swapDatabase(p.database, userId, ip)
    } catch (error) {
      // The old database stays: put its key back too.
      if (keptEnv) await d.worker("root.config.secretsRestore", { backup: keptEnv }).catch(() => {})
      throw error
    }
  } finally {
    await rm(p.dir, { recursive: true, force: true })
  }
}
