import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { chmod, copyFile, mkdtemp, open, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { once } from "node:events"
import { pipeline } from "node:stream/promises"
import { prisma, PrismaClient } from "@app/database"
import { requestSync } from "../nats"

// Encrypted configuration backups. Format 1 holds the database only; format 2
// (#1) is a tar the root worker builds, with the database, the secrets key and
// what only root can read (account ids, app definitions, storage descriptions,
// maintenance schedule). The envelope is the same: magic, salt, IV, AES-256-GCM
// ciphertext and tag, the key derived from the password with scrypt.

export const MAGIC_V1 = Buffer.from("HSI-CONFIG-V1\0", "ascii")
export const MAGIC_V2 = Buffer.from("HSI-CONFIG-V2\0", "ascii")
const MAGIC_SIZE = MAGIC_V1.length
const HEADER_SIZE = MAGIC_SIZE + 16 + 12
const AUTH_TAG_SIZE = 16

let restoreInProgress = false
export function restoreBusy(): boolean { return restoreInProgress }
export function setRestoreBusy(v: boolean) { restoreInProgress = v }

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Buffer) {
  if (!stream.write(chunk)) await once(stream, "drain")
}

/** Encrypts `src` into `dst` with the given format magic. */
export async function encryptToFile(src: string, dst: string, password: string, magic: Buffer) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(password, salt)
  try {
    const output = createWriteStream(dst, { flags: "wx", mode: 0o600 })
    await writeChunk(output, Buffer.concat([magic, salt, iv]))
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    for await (const chunk of createReadStream(src)) {
      const encryptedChunk = cipher.update(chunk as Buffer)
      if (encryptedChunk.length) await writeChunk(output, encryptedChunk)
    }
    await writeChunk(output, cipher.final())
    await writeChunk(output, cipher.getAuthTag())
    output.end()
    await once(output, "close")
  } finally {
    key.fill(0)
  }
}

/** Decrypts a backup into `output`; returns its format (1 or 2). */
export async function decryptToFile(encrypted: string, password: string, output: string): Promise<1 | 2> {
  const info = await stat(encrypted)
  if (info.size <= HEADER_SIZE + AUTH_TAG_SIZE + 100) throw new Error("Invalid or truncated HSI backup")
  const file = await open(encrypted, "r")
  const header = Buffer.alloc(HEADER_SIZE)
  const tag = Buffer.alloc(AUTH_TAG_SIZE)
  try {
    await file.read({ buffer: header, position: 0 })
    await file.read({ buffer: tag, position: info.size - AUTH_TAG_SIZE })
  } finally {
    await file.close()
  }
  const magic = header.subarray(0, MAGIC_SIZE)
  const format = magic.equals(MAGIC_V2) ? 2 : magic.equals(MAGIC_V1) ? 1 : 0
  if (!format) throw new Error("Unsupported HSI backup format")

  const salt = header.subarray(MAGIC_SIZE, MAGIC_SIZE + 16)
  const iv = header.subarray(MAGIC_SIZE + 16, HEADER_SIZE)
  const key = await deriveKey(password, salt)
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    await pipeline(
      createReadStream(encrypted, { start: HEADER_SIZE, end: info.size - AUTH_TAG_SIZE - 1 }),
      decipher,
      createWriteStream(output, { flags: "wx", mode: 0o600 }),
    )
  } catch {
    await rm(output, { force: true })
    throw new Error("Incorrect password or corrupted backup")
  } finally {
    key.fill(0)
  }
  return format
}

/** The staging root shared with the worker (created by it for this user). */
export async function stagingRoot(): Promise<string> {
  const r = await requestSync<{ dir: string }>("root.config.staging", { ownerUid: process.getuid?.() ?? 0 }, 10_000)
  return r.dir
}

export async function createEncryptedConfigBackup(password: string, hsiVersion: string) {
  if (restoreInProgress) throw new Error("A configuration restore is in progress")
  const dir = await mkdtemp(path.join(await stagingRoot(), "export-"))
  try {
    // VACUUM INTO produces a transactionally consistent standalone SQLite file
    // without pausing normal readers or copying a possibly active journal.
    const snapshot = path.join(dir, "database.db")
    await prisma.$executeRawUnsafe(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`)
    const key = process.env.HSI_SECRETS_KEY?.trim()
    if (key) await writeFile(path.join(dir, "secrets.json"), JSON.stringify({ HSI_SECRETS_KEY: key }), { mode: 0o600 })
    const users = await prisma.user.findMany({ select: { username: true } })
    const { path: tarPath } = await requestSync<{ path: string }>("root.config.export", {
      dir, usernames: users.map(u => u.username), hsiVersion, ownerUid: process.getuid?.() ?? 0,
    }, 120_000)
    const encrypted = path.join(dir, "config.hsibak")
    await encryptToFile(tarPath, encrypted, password, MAGIC_V2)
    // Only the encrypted file is left while it downloads.
    for (const f of ["database.db", "secrets.json", "backup.tar"]) await rm(path.join(dir, f), { force: true })
    const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z")
    return { path: encrypted, filename: `hsi-config-${stamp}.hsibak`, cleanup: () => rm(dir, { recursive: true, force: true }) }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function validateRestoredDatabase(filename: string) {
  const restored = new PrismaClient({ datasources: { db: { url: `file:${filename}` } } })
  try {
    const integrity = await restored.$queryRawUnsafe<Array<Record<string, string>>>("PRAGMA integrity_check")
    if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") throw new Error("Backup database integrity check failed")

    const objects = await restored.$queryRawUnsafe<Array<{ name: string; type: string }>>(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view', 'trigger')",
    )
    if (objects.some(item => item.type === "view" || item.type === "trigger")) throw new Error("Backup contains unsupported database objects")
    const tables = new Set(objects.filter(item => item.type === "table").map(item => item.name))
    const activeTables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    for (const { name } of activeTables) {
      // Tables added since the backup (SetupState...) are created empty by the
      // schema push at the next start; the others must be there.
      if (!tables.has(name)) {
        if (name === "SetupState") continue
        throw new Error(`Backup is missing required table ${name}`)
      }
      const quoted = name.replaceAll('"', '""')
      const [expectedColumns, backupColumns] = await Promise.all([
        prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${quoted}")`),
        restored.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${quoted}")`),
      ])
      const available = new Set(backupColumns.map(column => column.name))
      for (const column of expectedColumns) {
        if (!available.has(column.name)) throw new Error(`Backup schema is incompatible (missing ${name}.${column.name})`)
      }
    }
  } finally {
    await restored.$disconnect()
  }
}

/** What the restored database holds, for the preview. */
export async function countRestoredDatabase(filename: string) {
  const restored = new PrismaClient({ datasources: { db: { url: `file:${filename}` } } })
  try {
    const [users, groups, places, shares, connectors, placeRows] = await Promise.all([
      restored.user.count(), restored.group.count(), restored.place.count(), restored.share.count(),
      restored.notificationConnector.count(), restored.place.findMany({ select: { path: true } }),
    ])
    return { users, groups, places, shares, connectors, placePaths: placeRows.map(p => p.path) }
  } finally {
    await restored.$disconnect()
  }
}

async function currentDatabasePath() {
  const databases = await prisma.$queryRawUnsafe<Array<{ name: string; file: string }>>("PRAGMA database_list")
  const filename = databases.find(database => database.name === "main")?.file
  if (!filename || !path.isAbsolute(filename)) throw new Error("Unable to resolve the active database path")
  return filename
}

async function pruneRollbackCopies(databasePath: string) {
  const directory = path.dirname(databasePath)
  const prefix = `${path.basename(databasePath)}.pre-restore-`
  const sidecar = (name: string) => ["-journal", "-wal", "-shm"].some(suffix => name.endsWith(suffix))
  const copies = (await readdir(directory)).filter(name => name.startsWith(prefix) && !sidecar(name)).sort().reverse()
  for (const old of copies.slice(3)) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      await unlink(path.join(directory, `${old}${suffix}`)).catch(() => {})
    }
  }
}

/**
 * Replaces the active database with `restoredFile` (validated before), keeping
 * the previous one as a rollback copy. The caller restarts HSI afterwards.
 */
export async function swapDatabase(restoredFile: string, auditUserId: string, auditIp: string) {
  const active = await currentDatabasePath()
  // Next to the active database: rename() cannot cross filesystems (EXDEV).
  const dir = await mkdtemp(path.join(path.dirname(active), ".hsi-config-restore-"))
  let disconnected = false
  let replaced = false
  try {
    const local = path.join(dir, "restored.db")
    await copyFile(restoredFile, local)

    // Add the successful restore to the database that will become active. The
    // initiating account may not exist in an older/different backup.
    const restored = new PrismaClient({ datasources: { db: { url: `file:${local}` } } })
    try {
      const actor = await restored.user.findUnique({ where: { id: auditUserId }, select: { id: true } })
      await restored.auditLog.create({ data: { userId: actor?.id, action: "system.configRestore", ip: auditIp, success: true } })
    } finally {
      await restored.$disconnect()
    }

    const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z")
    const rollback = `${active}.pre-restore-${stamp}`
    await prisma.$disconnect()
    disconnected = true

    // SQLite sidecar files belong to the database they were written for: move
    // them with the rollback copy so they are never applied to the restored one.
    const sidecars = ["-journal", "-wal", "-shm"]
    await rename(active, rollback)
    for (const suffix of sidecars) await rename(active + suffix, rollback + suffix).catch(() => {})
    try {
      await rename(local, active)
      await chmod(active, 0o600)
      replaced = true
    } catch (error) {
      await rename(rollback, active).catch(() => {})
      for (const suffix of sidecars) await rename(rollback + suffix, active + suffix).catch(() => {})
      throw error
    }
    await pruneRollbackCopies(active)
    return { rollback }
  } finally {
    await rm(dir, { recursive: true, force: true })
    if (disconnected && !replaced) await prisma.$connect().catch(() => {})
  }
}
