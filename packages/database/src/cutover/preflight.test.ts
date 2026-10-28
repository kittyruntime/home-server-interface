import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import Database from "better-sqlite3"
import { inspectDatabase } from "./preflight"

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prisma/schema/migrations")
const baselineSql = path.join(migrationsDir, "0_baseline_v1680/migration.sql")
const shipped = (await readdir(migrationsDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()

// A database migrated by Prisma up to `count` shipped migrations, with its ledger.
async function migratedDatabase(filename: string, count: number, ledger = shipped.slice(0, count)) {
  const db = new Database(filename)
  for (const name of shipped.slice(0, count)) db.exec(await readFile(path.join(migrationsDir, name, "migration.sql"), "utf8"))
  db.exec(`CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, finished_at DATETIME, migration_name TEXT NOT NULL,
    logs TEXT, rolled_back_at DATETIME, started_at DATETIME NOT NULL DEFAULT current_timestamp, applied_steps_count INTEGER NOT NULL DEFAULT 0)`)
  const insert = db.prepare("INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, current_timestamp, ?, 1)")
  for (const name of ledger) {
    const checksum = createHash("sha256").update(await readFile(path.join(migrationsDir, name, "migration.sql"))).digest("hex")
    insert.run(name, checksum, name)
  }
  db.close()
}

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

test("recognizes v1.68.0 with the constraint and index names left by the v1.35.0 Role rename", async () => {
  const legacy: Array<[string, string]> = [
    ["GroupPlacePermission_groupId_fkey", "RolePlacePermission_roleId_fkey"],
    ["GroupPlacePermission_placeId_fkey", "RolePlacePermission_placeId_fkey"],
    ["UserGroup_userId_fkey", "UserRole_userId_fkey"],
    ["UserGroup_groupId_fkey", "UserRole_roleId_fkey"],
  ]
  const indexes: Array<[string, string]> = [
    ["GroupPlacePermission_groupId_placeId_key", "RolePlacePermission_roleId_placeId_key"],
    ["Group_name_key", "Role_name_key"],
  ]
  for (const names of [legacy, [...legacy, ...indexes]]) {
    await withDatabase(async filename => {
      let sql = await readFile(baselineSql, "utf8")
      for (const [current, old] of names) sql = sql.replaceAll(`"${current}"`, `"${old}"`)
      const db = new Database(filename)
      db.exec(sql)
      db.close()
      const inspection = inspectDatabase(filename)
      assert.equal(inspection.kind, "baseline")
    })
  }
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

test("recognizes every shipped migration step with its ledger", async () => {
  assert.ok(shipped.length >= 2)
  for (let count = 1; count <= shipped.length; count++) {
    await withDatabase(async filename => {
      await migratedDatabase(filename, count)
      assert.equal(inspectDatabase(filename).kind, "migrated")
    })
  }
})

test("refuses a schema that does not match its migration ledger", async () => {
  await withDatabase(async filename => {
    await migratedDatabase(filename, shipped.length, shipped.slice(0, 1))
    assert.throws(() => inspectDatabase(filename), /drifted SQLite schema/)
  })
})

test("refuses a ledger that skips or alters a shipped migration", async () => {
  await withDatabase(async filename => {
    await migratedDatabase(filename, 1, shipped.slice(1, 2))
    assert.throws(() => inspectDatabase(filename), /migration ledger/)
  })
  await withDatabase(async filename => {
    await migratedDatabase(filename, 1)
    const db = new Database(filename)
    db.exec("UPDATE _prisma_migrations SET checksum = 'stale'")
    db.close()
    assert.throws(() => inspectDatabase(filename), /migration ledger/)
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
