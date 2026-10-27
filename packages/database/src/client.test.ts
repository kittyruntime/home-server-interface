import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createPrismaClient } from "./index"

test("opens the requested absolute SQLite database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hsi-prisma-client-"))
  const client = createPrismaClient(`file:${path.join(dir, "test.db")}`)
  try {
    const result = await client.$queryRawUnsafe<Array<{ value: bigint }>>("SELECT 1 AS value")
    assert.equal(result[0]?.value, 1n)
  } finally {
    await client.$disconnect()
    await rm(dir, { recursive: true, force: true })
  }
})

test("refuses a relative SQLite URL", () => {
  assert.throws(() => createPrismaClient("file:relative.db"), /absolute/)
})
