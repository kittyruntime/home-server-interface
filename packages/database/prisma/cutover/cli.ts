import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { inspectDatabase } from "../../src/cutover/preflight"
import { reportCutoverError } from "./error"

const here = path.dirname(fileURLToPath(import.meta.url))
try {
const [command, filename, source] = process.argv.slice(2)
if (!command || !filename || !path.isAbsolute(filename)) throw new Error("usage: cli.ts inspect|convert|verify <absolute-db-path> [source-fingerprint]")

if (command === "inspect") {
  const result = inspectDatabase(filename)
  if (result.kind === "historical") {
    console.log([result.kind, result.fingerprint, Number(result.conversion.needsPermissions), Number(result.conversion.needsCompose), result.conversion.representativeRelease].join(" "))
  } else {
    console.log(result.kind)
  }
} else if (command === "convert") {
  if (!source || !/^[a-f0-9]{64}$/.test(source)) throw new Error("source fingerprint required")
  const conversions = JSON.parse(readFileSync(path.join(here, "conversions.json"), "utf8")) as Array<{ source: string; sql: string; sqlSha256: string }>
  const conversion = conversions.find(entry => entry.source === source)
  if (!conversion) throw new Error(`unknown source fingerprint ${source}`)
  const sqlPath = path.resolve(here, conversion.sql)
  if (!sqlPath.startsWith(here + path.sep)) throw new Error("conversion SQL escapes cutover directory")
  const sql = readFileSync(sqlPath)
  if (createHash("sha256").update(sql).digest("hex") !== conversion.sqlSha256) throw new Error("conversion SQL checksum mismatch")
  const db = new Database(filename)
  try {
    db.exec(sql.toString())
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("SQLite integrity check failed after conversion")
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("foreign key check failed after conversion")
  } finally { db.close() }
  if (inspectDatabase(filename).kind !== "baseline") throw new Error("converted schema does not match the v1.68.0 baseline")
  console.log("converted and verified")
} else if (command === "verify") {
  const result = inspectDatabase(filename)
  if (result.kind !== "baseline" && result.kind !== "migrated") throw new Error(`database is ${result.kind}, expected baseline or migrated`)
  console.log(result.kind)
} else {
  throw new Error(`unknown cutover command: ${command}`)
}
} catch (error) { reportCutoverError(error) }
