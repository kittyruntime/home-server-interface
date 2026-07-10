import { adminProcedure, router } from "../index"
import { z } from "zod"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))

function installDir(): string {
  if (process.env.INSTALL_DIR) return process.env.INSTALL_DIR
  // dev: src/trpc/routers → ../../../../../ = repo root
  return path.resolve(dirname, "../../../../..")
}

function readCurrentVersion(): string {
  const vf = path.join(installDir(), "VERSION")
  if (fs.existsSync(vf)) return fs.readFileSync(vf, "utf8").trim()
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installDir(), "package.json"), "utf8"))
    return `v${pkg.version}`
  } catch { return "unknown" }
}

type CheckResult = { latestVersion: string; checkedAt: string; releaseNotes?: string }

function readCheck(): CheckResult | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(installDir(), ".update-check.json"), "utf8"))
  } catch { return null }
}

function isNewer(candidate: string, current: string): boolean {
  const toInts = (v: string) => v.replace(/^v/, "").split(".").map(x => parseInt(x) || 0)
  const [caMaj=0, caMin=0, caPatch=0] = toInts(candidate)
  const [cuMaj=0, cuMin=0, cuPatch=0] = toInts(current)
  if (caMaj !== cuMaj) return caMaj > cuMaj
  if (caMin !== cuMin) return caMin > cuMin
  return caPatch > cuPatch
}

const GITHUB_REPO = "kittyruntime/home-server-interface"

export const updateRouter = router({
  status: adminProcedure.query(() => {
    const current  = readCurrentVersion()
    const check    = readCheck()
    const pending  = fs.existsSync(path.join(installDir(), ".pending-update"))
    const hasUpdate = check ? isNewer(check.latestVersion, current) : false
    return {
      current,
      latest:       check?.latestVersion  ?? null,
      hasUpdate,
      checkedAt:    check?.checkedAt      ?? null,
      releaseNotes: check?.releaseNotes   ?? null,
      pending,
      repoUrl:      `https://github.com/${GITHUB_REPO}`,
    }
  }),

  check: adminProcedure.mutation(async () => {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { "User-Agent": "hsi-update-checker", Accept: "application/vnd.github+json" } }
    )
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`)
    const data = await res.json() as { tag_name: string; body?: string }
    const result: CheckResult = {
      latestVersion: data.tag_name,
      checkedAt: new Date().toISOString(),
      releaseNotes: data.body?.slice(0, 4000),
    }
    fs.writeFileSync(
      path.join(installDir(), ".update-check.json"),
      JSON.stringify(result),
      "utf8"
    )
    return result
  }),

  apply: adminProcedure
    .input(z.object({ version: z.string().regex(/^v\d+\.\d+\.\d+$/) }))
    .mutation(({ input }) => {
      fs.writeFileSync(path.join(installDir(), ".pending-update"), input.version, "utf8")
      return { ok: true }
    }),
})
