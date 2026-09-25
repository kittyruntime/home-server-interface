// Repair: compose.yaml files written by v1.53.0–v1.54.0 (the 2026-09-23 compose
// migration and the App Store) reference named volumes without declaring them
// at the top level, and Compose rejects the whole project ("service refers to
// undefined volume"): such apps could not be started, stopped or deleted.
// Adds `volumes: { <name>: { name: <name> } }` for every missing declaration,
// pinning the exact Docker volume name so migrated apps keep their existing
// volume and data. Idempotent: files that need no change are left untouched.
//
// Run (prod):  handled by scripts/install.sh (data-migrations loop, as the app
//              user, which owns /opt/containers).
// Test (copy): HSI_CONTAINERS_DIR=/tmp/stacks \
//              pnpm --filter @app/database exec vite-node prisma/data-migrations/2026-09-25-compose-named-volumes.ts
import { readdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { repairNamedVolumeDeclarations } from "@app/compose"

const stacksDir = process.env.HSI_CONTAINERS_DIR ?? "/opt/containers"

async function main() {
  let entries: string[]
  try { entries = await readdir(stacksDir) } catch { console.log(`no ${stacksDir} - nothing to repair`); return }

  let repaired = 0
  for (const name of entries) {
    const composePath = path.join(stacksDir, name, "compose.yaml")
    let content: string
    try { content = await readFile(composePath, "utf8") } catch { continue }
    const fixed = repairNamedVolumeDeclarations(content)
    if (fixed === null) continue
    const tmp = `${composePath}.hsi-repair-${process.pid}.tmp`
    await writeFile(tmp, fixed, "utf8")
    await rename(tmp, composePath)
    console.log(`declared named volumes in ${composePath}`)
    repaired++
  }
  console.log(`compose named-volume repair: ${repaired} file(s) updated`)
}

main().catch(e => { console.error(e); process.exit(1) })
