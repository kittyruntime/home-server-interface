import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dbDir = mkdtempSync(join(tmpdir(), "hsi-smoke-"))
process.on("exit", () => rmSync(dbDir, { recursive: true, force: true }))

const child = spawn(process.execPath, ["apps/backend/dist/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET: "backend-smoke-test-secret-at-least-32-characters",
    HSI_SMOKE_TEST: "1",
    DATABASE_URL: `file:${join(dbDir, "smoke.db")}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
})

let output = ""
child.stdout.on("data", chunk => { output += chunk })
child.stderr.on("data", chunk => { output += chunk })

const exited = new Promise(resolve => {
  child.once("exit", (code, signal) => {
    resolve({ code, signal })
  })
})

const result = await Promise.race([
  exited,
  new Promise(resolve => setTimeout(() => resolve(null), 10_000)),
])

if (!result) {
  child.kill("SIGKILL")
  await exited
  process.stderr.write(output)
  throw new Error("Backend artifact smoke test timed out")
}

if (result.code !== 0) {
  process.stderr.write(output)
  throw new Error(`Backend artifact failed its smoke test: ${JSON.stringify(result)}`)
}

console.log("Backend artifact smoke test passed")
