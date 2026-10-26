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

function canonicalSchema(db: Database.Database): string {
  const rows = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' AND sql IS NOT NULL").all() as Array<{ type: string; name: string; sql: string }>
  const entries = rows.map(({ type, name, sql }) => [type, name, sql.replace(/\s+/g, "").toLowerCase()])
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
  if (!stat.isFile() || stat.size === 0) throw new Error("unknown SQLite database: missing or partial file; restore the pre-update snapshot before retrying")

  const inventory = JSON.parse(readFileSync(path.join(cutoverDir, "states.json"), "utf8")) as { states: State[] }
  const conversions = JSON.parse(readFileSync(path.join(cutoverDir, "conversions.json"), "utf8")) as Conversion[]
  const baseline = inventory.states[0]!.sqliteSha256
  const db = new Database(filename, { readonly: true, fileMustExist: true })
  try {
    const integrity = db.pragma("integrity_check", { simple: true })
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${String(integrity)}; restore the pre-update snapshot`)
    if ((db.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new Error("SQLite foreign key check failed; restore the pre-update snapshot or contact support")
    }
    const fingerprint = canonicalSchema(db)
    const hasLedger = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'").get())
    if (hasLedger) {
      let rows: Array<{ migration_name: string; checksum: string; finished_at: string | null; rolled_back_at: string | null }>
      try {
        rows = db.prepare("SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations").all() as typeof rows
      } catch {
        throw new Error("unrecognized Prisma migration ledger; restore the pre-update snapshot or contact support")
      }
      const expectedChecksum = sha256(readFileSync(baselinePath))
      if (rows.length !== 1 || rows[0]?.migration_name !== "0_baseline_v1680" || rows[0]?.checksum !== expectedChecksum || !rows[0]?.finished_at || rows[0]?.rolled_back_at) {
        throw new Error("unrecognized or partial Prisma migration ledger; restore the pre-update snapshot or contact support")
      }
      if (fingerprint !== baseline) throw new Error("drifted SQLite schema with Prisma migration ledger; restore the pre-update snapshot or contact support")
      return { kind: "migrated", fingerprint }
    }
    if (fingerprint === baseline) return { kind: "baseline", fingerprint }
    const known = inventory.states.find(state => state.sqliteSha256 === fingerprint)
    const conversion = conversions.find(item => item.source === fingerprint)
    if (!known || !conversion) throw new Error(`unknown or drifted SQLite schema (${fingerprint}); restore the pre-update snapshot or contact support`)
    const sqlFile = path.resolve(cutoverDir, conversion.sql)
    if (!sqlFile.startsWith(cutoverDir + path.sep) || sha256(readFileSync(sqlFile)) !== conversion.sqlSha256) {
      throw new Error(`conversion checksum mismatch for ${fingerprint}; restore the release archive`)
    }
    return { kind: "historical", fingerprint, conversion }
  } finally {
    db.close()
  }
}
