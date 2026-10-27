import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import Database from "better-sqlite3"
import { inspectDatabase } from "./preflight"

const baselineSql = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prisma/schema/migrations/0_baseline_v1680/migration.sql")

async function withDatabase(run: (filename: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hsi-cutover-preflight-"))
  try { await run(path.join(dir, "state.db")) } finally { await rm(dir, { recursive: true, force: true }) }
}

test("recognizes a missing database as a fresh install", async () => {
  await withDatabase(async filename => {
    assert.equal(inspectDatabase(filename).kind, "fresh")
  })
})

test("recognizes a zero-byte database left by an interrupted fresh install", async () => {
  await withDatabase(async filename => {
    await writeFile(filename, "")
    assert.equal(inspectDatabase(filename).kind, "fresh")
    assert.equal((await readFile(filename)).length, 0)
  })
})

test("refuses to discard a non-empty WAL beside a zero-byte database", async () => {
  await withDatabase(async filename => {
    await writeFile(filename, "")
    await writeFile(`${filename}-wal`, "recoverable-data")
    assert.throws(() => inspectDatabase(filename), /WAL may contain data/)
    assert.equal((await readFile(`${filename}-wal`)).toString(), "recoverable-data")
  })
})

test("recognizes an exact v1.68.0 schema without ledger", async () => {
  await withDatabase(async filename => {
    const db = new Database(filename)
    db.exec(await readFile(baselineSql, "utf8"))
    db.close()
    assert.equal(inspectDatabase(filename).kind, "baseline")
  })
})

test("refuses drift without changing the database", async () => {
  await withDatabase(async filename => {
    const db = new Database(filename)
    db.exec(await readFile(baselineSql, "utf8"))
    db.exec("CREATE TABLE manual_drift (id INTEGER PRIMARY KEY)")
    db.close()
    const before = createHash("sha256").update(await readFile(filename)).digest("hex")
    assert.throws(() => inspectDatabase(filename), /unrecognized SQLite schema \(fingerprint [a-f0-9]{64}\)/i)
    assert.equal(createHash("sha256").update(await readFile(filename)).digest("hex"), before)
  })
})

test("refuses a known schema with broken foreign keys", async () => {
  await withDatabase(async filename => {
    const db = new Database(filename)
    db.exec(await readFile(baselineSql, "utf8"))
    db.exec("PRAGMA foreign_keys=OFF; INSERT INTO UserGroup (userId, groupId) VALUES ('missing-user', 'missing-group')")
    db.close()
    assert.throws(() => inspectDatabase(filename), /foreign key check/i)
  })
})

test("refuses any unrecognized Prisma migration ledger", async () => {
  await withDatabase(async filename => {
    const db = new Database(filename)
    db.exec(await readFile(baselineSql, "utf8"))
    db.exec("CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TEXT)")
    db.exec("INSERT INTO _prisma_migrations VALUES ('20260619150447_add_user_wallpaper', 'stale', '2026-01-01')")
    db.close()
    assert.throws(() => inspectDatabase(filename), /migration ledger/i)
  })
})


test("selects the versioned conversion from a historical SQLite fingerprint", async () => {
  await withDatabase(async filename => {
    const db = new Database(filename)
    const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scripts/tests/fixtures/database/v1.64.2.sql")
    db.exec(await readFile(fixture, "utf8"))
    db.close()
    const result = inspectDatabase(filename)
    assert.equal(result.kind, "historical")
    if (result.kind === "historical") {
      assert.equal(result.conversion.representativeRelease, "v1.64.2")
      assert.equal(result.conversion.needsPermissions, false)
    }
  })
})
