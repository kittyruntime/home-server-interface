import { adminProcedure, router } from "../index"
import { z } from "zod"
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { requestSync } from "../../nats"
import { log } from "../../utils/log"

const dirname = path.dirname(fileURLToPath(import.meta.url))

function installDir(): string {
  if (process.env.INSTALL_DIR) return process.env.INSTALL_DIR
  // dev: src/trpc/routers → ../../../../../ = repo root
  return path.resolve(dirname, "../../../../..")
}

// install.sh chowns INSTALL_DIR/database/data to the app user but leaves
// INSTALL_DIR itself root-owned (0755) once the release install/update flow
// has run. The backend runs unprivileged, so the pending-update marker must
// live somewhere it can actually create a file — database/data is the one
// directory install.sh guarantees it owns. Mirrored in scripts/install.sh
// (stale-marker cleanup, the update-apply path unit and its service).
//
// The release tarball flattens the monorepo (database/ sits directly under
// INSTALL_DIR); in the dev checkout the same data dir is nested under
// packages/. INSTALL_DIR is only set in production, so its presence tells
// us which layout applies.
function dbDataDir(): string {
  return process.env.INSTALL_DIR
    ? path.join(installDir(), "database", "data")
    : path.join(installDir(), "packages", "database", "data")
}

function pendingUpdateFile(): string {
  return path.join(dbDataDir(), ".pending-update")
}

// Same constraint as the pending-update marker: a fresh install cannot create
// files in INSTALL_DIR itself. Mirrored in scripts/install.sh (hsi-check-update).
function updateCheckFile(): string {
  return path.join(dbDataDir(), ".update-check.json")
}

// Written by versions before the move; read as a fallback until the next check.
function legacyUpdateCheckFile(): string {
  return path.join(installDir(), ".update-check.json")
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
  for (const file of [updateCheckFile(), legacyUpdateCheckFile()]) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as CheckResult
    } catch { /* missing or unreadable: try the next location */ }
  }
  return null
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
let restartScheduled = false

// ── Pre-flight checks ─────────────────────────────────────────────────────────
// Run before applying an update to catch the obvious failure modes (no disk
// space, a service already down, an update already in flight). Each check is
// independent and non-blocking: a `fail` blocks the install in the UI, a `warn`
// lets it through with a visible caveat.

type PreflightStatus = "ok" | "warn" | "fail"
type PreflightCheck = { id: string; label: string; status: PreflightStatus; detail?: string }

const MIN_FREE_BYTES = 500 * 1024 * 1024 // 500 MB headroom for download + extract

function diskFreeBytes(dir: string): Promise<number> {
  return new Promise((resolve) => {
    // -P: POSIX output (single line per fs), -k: 1024-byte blocks. df can wrap
    // long device names onto their own line, so parse the last field group.
    execFile("df", ["-Pk", dir], (err, stdout) => {
      if (err) return resolve(-1)
      const lines = stdout.trim().split("\n")
      const last = lines[lines.length - 1] ?? ""
      const cols = last.trim().split(/\s+/)
      // If the device name wrapped, the numbers are on the next line; take the
      // line that has at least 4 numeric fields.
      const dataLine = cols.length >= 4 ? cols : (lines[lines.length - 2] ?? "").trim().split(/\s+/)
      const availKb = parseInt(dataLine[3] ?? "", 10)
      resolve(Number.isFinite(availKb) ? availKb * 1024 : -1)
    })
  })
}

function systemdActive(unit: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", "--quiet", unit], (err) => resolve(!err))
  })
}

function fmtMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

export const updateRouter = router({
  status: adminProcedure.query(() => {
    const current  = readCurrentVersion()
    const check    = readCheck()
    const pending  = fs.existsSync(pendingUpdateFile())
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
    try {
      fs.writeFileSync(updateCheckFile(), JSON.stringify(result), "utf8")
    } catch (e) {
      // The check itself succeeded: report the latest version, but say why it
      // will not be remembered instead of failing the whole request.
      log.error({ err: e, file: updateCheckFile() }, "update: could not save the check result")
    }
    return result
  }),

  preflight: adminProcedure.query(async (): Promise<{ checks: PreflightCheck[]; canApply: boolean }> => {
    const checks: PreflightCheck[] = []

    // 1. Free disk space on the install partition
    const free = await diskFreeBytes(installDir())
    if (free < 0) {
      checks.push({ id: "disk", label: "Free disk space", status: "warn", detail: "Could not determine free space" })
    } else if (free < MIN_FREE_BYTES) {
      checks.push({ id: "disk", label: "Free disk space", status: "fail", detail: `Only ${fmtMb(free)} free — ${fmtMb(MIN_FREE_BYTES)} recommended` })
    } else {
      checks.push({ id: "disk", label: "Free disk space", status: "ok", detail: `${fmtMb(free)} available` })
    }

    // 2. HSI services are up (so the update can actually restart into the new version)
    const units = ["hsi", "hsi-root-worker", "hsi-nats"] as const
    const states = await Promise.all(units.map(u => systemdActive(u)))
    const down = units.filter((_, i) => !states[i])
    if (down.length === 0) {
      checks.push({ id: "services", label: "HSI services", status: "ok", detail: "hsi, hsi-root-worker, hsi-nats all active" })
    } else {
      checks.push({ id: "services", label: "HSI services", status: "fail", detail: `Inactive: ${down.join(", ")}` })
    }

    // 3. No update already in flight
    const pending = fs.existsSync(pendingUpdateFile())
    checks.push(
      pending
        ? { id: "pending", label: "No pending update", status: "fail", detail: "An update is already scheduled — restart to apply it first" }
        : { id: "pending", label: "No pending update", status: "ok" },
    )

    // 4. Current version is known (otherwise we can't reason about the upgrade)
    const current = readCurrentVersion()
    checks.push(
      current === "unknown"
        ? { id: "version", label: "Current version", status: "warn", detail: "Could not determine the running version" }
        : { id: "version", label: "Current version", status: "ok", detail: current },
    )

    // 5. A release check has succeeded at least once (GitHub reachable)
    const check = readCheck()
    checks.push(
      check
        ? { id: "release", label: "Release info", status: "ok", detail: `Last checked ${check.checkedAt}` }
        : { id: "release", label: "Release info", status: "warn", detail: "Never checked for updates — run a check first" },
    )

    const canApply = checks.every(c => c.status !== "fail")
    return { checks, canApply }
  }),

  apply: adminProcedure
    .input(z.object({ version: z.string().regex(/^v\d+\.\d+\.\d+$/) }))
    .mutation(({ input }) => {
      fs.writeFileSync(pendingUpdateFile(), input.version, "utf8")
      return { ok: true }
    }),

  restart: adminProcedure.mutation(() => {
    if (!restartScheduled) {
      restartScheduled = true
      // Respond to the browser and let the audit write complete before exiting.
      // The service supervisor starts the backend again after EX_TEMPFAIL.
      const timer = setTimeout(() => process.exit(75), 750)
      timer.unref()
    }
    return { ok: true }
  }),

  rebootHost: adminProcedure.mutation(async () => {
    await requestSync<{ scheduled: boolean }>("root.sys.reboot", {}, 5_000)
    return { ok: true }
  }),
})
