import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { chmod, mkdtemp, open, readdir, rename, rm, stat, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import { pipeline } from "node:stream/promises"
import { prisma, PrismaClient } from "@app/database"

const MAGIC = Buffer.from("HSI-CONFIG-V1\0", "ascii")
const HEADER_SIZE = MAGIC.length + 16 + 12
const AUTH_TAG_SIZE = 16
let restoreInProgress = false

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

export async function createEncryptedConfigBackup(password: string) {
  if (restoreInProgress) throw new Error("A configuration restore is in progress")
  const dir = await mkdtemp(path.join(os.tmpdir(), "hsi-config-backup-"))
  const snapshot = path.join(dir, "config.db")
  const encrypted = path.join(dir, "config.hsibak")
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(password, salt)

  try {
    // VACUUM INTO produces a transactionally consistent standalone SQLite file
    // without pausing normal readers or copying a possibly active journal.
    const escapedSnapshot = snapshot.replaceAll("'", "''")
    await prisma.$executeRawUnsafe(`VACUUM INTO '${escapedSnapshot}'`)

    const output = createWriteStream(encrypted, { flags: "wx", mode: 0o600 })
    await writeChunk(output, Buffer.concat([MAGIC, salt, iv]))
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    for await (const chunk of createReadStream(snapshot)) {
      const encryptedChunk = cipher.update(chunk as Buffer)
      if (encryptedChunk.length) await writeChunk(output, encryptedChunk)
    }
    await writeChunk(output, cipher.final())
    await writeChunk(output, cipher.getAuthTag())
    output.end()
    await once(output, "close")

    const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z")
    return { path: encrypted, filename: `hsi-config-${stamp}.hsibak`, cleanup: () => rm(dir, { recursive: true, force: true }) }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  } finally {
    key.fill(0)
  }
}

async function validateRestoredDatabase(filename: string) {
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
      if (!tables.has(name)) throw new Error(`Backup is missing required table ${name}`)
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

async function decryptBackup(encrypted: string, password: string, output: string) {
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
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Unsupported HSI backup format")

  const salt = header.subarray(MAGIC.length, MAGIC.length + 16)
  const iv = header.subarray(MAGIC.length + 16, HEADER_SIZE)
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
    throw new Error("Incorrect password or corrupted backup")
  } finally {
    key.fill(0)
  }
}

async function currentDatabasePath() {
  const databases = await prisma.$queryRawUnsafe<Array<{ name: string; file: string }>>("PRAGMA database_list")
  const filename = databases.find(database => database.name === "main")?.file
  if (!filename || !path.isAbsolute(filename)) throw new Error("Unable to resolve the active database path")
  return filename
}

export async function verifyEncryptedConfigBackup(encrypted: string, password: string) {
  if (restoreInProgress) throw new Error("A configuration restore is in progress")
  const dir = await mkdtemp(path.join(os.tmpdir(), "hsi-config-verify-"))
  try {
    const decrypted = path.join(dir, "verified.db")
    await decryptBackup(encrypted, password, decrypted)
    await validateRestoredDatabase(decrypted)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

export async function restoreEncryptedConfigBackup(encrypted: string, password: string, auditUserId: string, auditIp: string) {
  if (restoreInProgress) throw new Error("A configuration restore is already in progress")
  restoreInProgress = true
  let dir: string | null = null
  let disconnected = false
  let replaced = false
  try {
    // Stage the decrypted database next to the active one: rename() cannot
    // cross filesystems (EXDEV), and /tmp is often a separate tmpfs.
    const active = await currentDatabasePath()
    dir = await mkdtemp(path.join(path.dirname(active), ".hsi-config-restore-"))
    const restoredFile = path.join(dir, "restored.db")
    await decryptBackup(encrypted, password, restoredFile)
    await validateRestoredDatabase(restoredFile)

    // Add the successful restore to the database that will become active. The
    // initiating account may not exist in an older/different backup.
    const restored = new PrismaClient({ datasources: { db: { url: `file:${restoredFile}` } } })
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
      await rename(restoredFile, active)
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
    // Removes the decrypted plaintext on success and failure alike.
    if (dir) await rm(dir, { recursive: true, force: true })
    if (disconnected && !replaced) await prisma.$connect().catch(() => {})
    if (!replaced) restoreInProgress = false
  }
}
