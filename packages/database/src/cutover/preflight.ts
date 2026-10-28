import { createHash } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"

const cutoverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prisma/cutover")
const baselinePath = path.resolve(cutoverDir, "../schema/migrations/0_baseline_v1680/migration.sql")

type State = { sqliteSha256: string; releases: string[] }
type Conversion = { representativeRelease: string; source: string; sql: string; sqlSha256: string; needsPermissions: boolean; needsCompose: boolean }
export type Inspection =
  | { kind: "fresh" }
  | { kind: "baseline"; fingerprint: string }
  | { kind: "migrated"; fingerprint: string }
  | { kind: "historical"; fingerprint: string; conversion: Conversion }

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

// The Users+Groups transform of v1.35.0 renamed the Role tables with ALTER TABLE,
// which keeps the names of their constraints and indexes. An installation that
// went through it still carries them on the renamed tables, while the published
// states were built fresh. These names change nothing for SQLite or Prisma: on
// the renamed tables only, read them as the current ones (before v1.35.0 they
// are the right names of the Role tables). inventory.py does the same.
const LEGACY_NAMES = new Map([
  ["RolePlacePermission_roleId_fkey", "GroupPlacePermission_groupId_fkey"],
  ["RolePlacePermission_placeId_fkey", "GroupPlacePermission_placeId_fkey"],
  ["RolePlacePermission_roleId_placeId_key", "GroupPlacePermission_groupId_placeId_key"],
  ["UserRole_userId_fkey", "UserGroup_userId_fkey"],
  ["UserRole_roleId_fkey", "UserGroup_groupId_fkey"],
  ["Role_name_key", "Group_name_key"],
])
const LEGACY_SQL_NAMES = new Map([...LEGACY_NAMES].map(([legacy, current]) => [legacy.toLowerCase(), current.toLowerCase()]))
const RENAMED_TABLES = new Set(["Group", "GroupPlacePermission", "UserGroup"])

function canonicalSchema(db: Database.Database): string {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' AND sql IS NOT NULL").all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>
  const entries = rows.map(({ type, name, tbl_name, sql }) => {
    const canonical = sql.replace(/\s+/g, "").toLowerCase()
    if (!RENAMED_TABLES.has(tbl_name)) return [type, name, canonical]
    return [
      type,
      LEGACY_NAMES.get(name) ?? name,
      canonical.replace(/"([a-z_]+)"/g, (quoted, n: string) => {
        const current = LEGACY_SQL_NAMES.get(n)
        return current ? `"${current}"` : quoted
      }),
    ]
  })
  entries.sort((left, right) => {
    for (let i = 0; i < 3; i++) {
      if (left[i]! < right[i]!) return -1
      if (left[i]! > right[i]!) return 1
    }
    return 0
  })
  return sha256(JSON.stringify(entries))
}

export function inspectDatabase(filename: string): Inspection {
  if (!path.isAbsolute(filename)) throw new Error("SQLite path must be absolute")
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(filename) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "fresh" }
    throw error
  }
  if (!stat.isFile()) throw new Error("SQLite database path is not a regular file")
  if (stat.size === 0) {
    // A zero-byte file can be left by an interrupted first installation.
    // Keep a non-empty WAL out of this path: it may contain recoverable data.
    let wal: ReturnType<typeof lstatSync> | undefined
    try { wal = lstatSync(`${filename}-wal`) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (wal && (!wal.isFile() || wal.size > 0)) throw new Error("SQLite database file is empty but its WAL may contain data")
    return { kind: "fresh" }
  }

  const inventory = JSON.parse(readFileSync(path.join(cutoverDir, "states.json"), "utf8")) as { states: State[] }
  const conversions = JSON.parse(readFileSync(path.join(cutoverDir, "conversions.json"), "utf8")) as Conversion[]
  const baseline = inventory.states[0]!.sqliteSha256
  let db: Database.Database
  try { db = new Database(filename, { readonly: true, fileMustExist: true }) }
  catch { throw new Error("SQLite database file cannot be opened") }
  try {
    let integrity: unknown
    try { integrity = db.pragma("integrity_check", { simple: true }) }
    catch { throw new Error("SQLite database file is corrupt or is not a database") }
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${String(integrity)}`)
    if ((db.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new Error("SQLite foreign key check failed")
    }
    const fingerprint = canonicalSchema(db)
    const hasLedger = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'").get())
    if (hasLedger) {
      let rows: Array<{ migration_name: string; checksum: string; finished_at: string | null; rolled_back_at: string | null }>
      try {
        rows = db.prepare("SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations").all() as typeof rows
      } catch {
        throw new Error("unrecognized Prisma migration ledger")
      }
      const expectedChecksum = sha256(readFileSync(baselinePath))
      if (rows.length !== 1 || rows[0]?.migration_name !== "0_baseline_v1680" || rows[0]?.checksum !== expectedChecksum || !rows[0]?.finished_at || rows[0]?.rolled_back_at) {
        throw new Error("unrecognized or partial Prisma migration ledger")
      }
      if (fingerprint !== baseline) throw new Error(`drifted SQLite schema with Prisma migration ledger (fingerprint ${fingerprint})`)
      return { kind: "migrated", fingerprint }
    }
    if (fingerprint === baseline) return { kind: "baseline", fingerprint }
    const known = inventory.states.find(state => state.sqliteSha256 === fingerprint)
    const conversion = conversions.find(item => item.source === fingerprint)
    if (!known || !conversion) throw new Error(`unrecognized SQLite schema (fingerprint ${fingerprint})`)
    const sqlFile = path.resolve(cutoverDir, conversion.sql)
    if (!sqlFile.startsWith(cutoverDir + path.sep) || sha256(readFileSync(sqlFile)) !== conversion.sqlSha256) {
      throw new Error(`conversion checksum mismatch for ${fingerprint}; reinstall the release archive`)
    }
    return { kind: "historical", fingerprint, conversion }
  } finally {
    db.close()
  }
}
