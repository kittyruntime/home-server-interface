import { prisma } from "@app/database"
import { requestSync } from "../nats"
import { dispatchEvent, type NotificationEvent, type Severity } from "./notifications"

type CheckResult = { target: string; message: string; severity: Severity }
type CheckOutcome = { found: CheckResult[]; checked: string[] }
type Checker = { source: string; check: () => Promise<CheckOutcome> }

type RaidArray = {
  name: string
  level: string
  state: string
  devices: string[]
  active: number
  total: number
}

async function checkRaid(): Promise<CheckOutcome> {
  const res = await requestSync<{ raids: RaidArray[] }>("root.sys.blockdevices", {}, 15_000)
  const checked = res.raids.map(r => r.name)
  const found = res.raids
    .filter(r => !((r.state === "active" || r.state === "clean") && r.active === r.total))
    .map((r): CheckResult => ({
      target: r.name,
      message: `${r.active}/${r.total} devices active (${r.state})`,
      severity: r.active === 0 ? "critical" : "warning",
    }))
  return { found, checked }
}

type BlockDevLite = { name: string; type: string }

type SmartAttr = { isCritical: boolean; raw: number }
type SmartResult = {
  available: boolean
  healthPassed: boolean
  attributes: SmartAttr[]
  nvme?: { criticalWarning: number; mediaErrors: number }
}

// Mirrors apps/dashboard/src/composables/useSmart.ts's smartStatus — same
// classification over the same already-computed (root-worker-side) data,
// duplicated here (not shared) since it's 6 lines and this is the only other
// place that needs it.
function deriveSmartStatus(s: SmartResult): "passed" | "warning" | "failed" | "unknown" {
  if (!s.available) return "unknown"
  if (!s.healthPassed) return "failed"
  if (s.attributes.some(a => a.isCritical && a.raw > 0)) return "warning"
  if (s.nvme && (s.nvme.criticalWarning > 0 || s.nvme.mediaErrors > 0)) return "warning"
  return "passed"
}

async function checkSmart(): Promise<CheckOutcome> {
  const { devices } = await requestSync<{ devices: BlockDevLite[] }>("root.sys.blockdevices", {}, 15_000)
  const disks = devices.filter(d => d.type === "disk")
  const found: CheckResult[] = []
  const checked: string[] = []
  for (const d of disks) {
    let smart: SmartResult
    try {
      smart = await requestSync<SmartResult>("root.sys.smart", { device: d.name, noWake: true }, 15_000)
    } catch {
      continue // unreadable this tick — not checked, leave any existing alert alone
    }
    if (!smart.available) continue // skipped (e.g. disk in standby) — not checked this tick, leave any existing alert alone
    checked.push(d.name)
    const status = deriveSmartStatus(smart)
    if (status === "warning" || status === "failed") {
      found.push({ target: d.name, message: `SMART status: ${status}`, severity: status === "failed" ? "critical" : "warning" })
    }
  }
  return { found, checked }
}

async function getThresholds(): Promise<{ warning: number; critical: number }> {
  const row = await prisma.alertThreshold.findUnique({ where: { id: "default" } })
  return {
    warning: row?.diskUsageWarningPercent ?? 80,
    critical: row?.diskUsageCriticalPercent ?? 90,
  }
}

// One Place can share a filesystem with another (two Places under the same
// mount) — check each distinct path once, not once per Place, so a full
// filesystem doesn't produce N identical alerts for N Places on it.
async function checkDiskUsage(): Promise<CheckOutcome> {
  const places = await prisma.place.findMany({ select: { path: true } })
  const paths = [...new Set(places.map(p => p.path))]
  const { warning, critical } = await getThresholds()
  const found: CheckResult[] = []
  const checked: string[] = []
  for (const path of paths) {
    let usage: { total: number; free: number }
    try {
      usage = await requestSync<{ total: number; free: number }>("root.fs.diskusage", { path, allowedRoot: "" }, 15_000)
    } catch {
      continue // unreadable this tick (e.g. Place path temporarily gone) — leave any existing alert alone
    }
    if (usage.total <= 0) continue
    checked.push(path)
    const usedPercent = ((usage.total - usage.free) / usage.total) * 100
    if (usedPercent >= critical) {
      found.push({ target: path, message: `Disk usage: ${usedPercent.toFixed(1)}% (critical, threshold ${critical}%)`, severity: "critical" })
    } else if (usedPercent >= warning) {
      found.push({ target: path, message: `Disk usage: ${usedPercent.toFixed(1)}% (warning, threshold ${warning}%)`, severity: "warning" })
    }
  }
  return { found, checked }
}

const checkers: Checker[] = [
  { source: "storage.raid", check: checkRaid },
  { source: "storage.smart", check: checkSmart },
  { source: "storage.disk-usage", check: checkDiskUsage },
]

// Pure diff between the previous alert set (source-scoped) and this tick's
// findings. Targets that were not checked are ignored (kept as-is).
export function diffAlerts(
  source: string,
  prev: Array<{ target: string; severity: string; message: string }>,
  checked: string[],
  found: Array<{ target: string; severity: Severity; message: string }>,
  now: string,
): { raised: NotificationEvent[]; cleared: NotificationEvent[] } {
  const checkedSet = new Set(checked)
  const foundByTarget = new Map(found.map(f => [f.target, f]))
  const raised: NotificationEvent[] = []
  const cleared: NotificationEvent[] = []
  for (const f of found) {
    const was = prev.find(p => p.target === f.target)
    if (!was || was.severity !== f.severity) {
      raised.push({ type: "alert.raised", severity: f.severity, source, target: f.target, message: f.message, time: now })
    }
  }
  for (const p of prev) {
    if (!checkedSet.has(p.target) || foundByTarget.has(p.target)) continue
    cleared.push({ type: "alert.cleared", severity: (p.severity as Severity), source, target: p.target, message: p.message, time: now })
  }
  return { raised, cleared }
}

async function runChecks(): Promise<void> {
  for (const { source, check } of checkers) {
    let outcome: CheckOutcome | null
    try {
      outcome = await check()
    } catch {
      outcome = null // transient failure — leave this source's existing alerts as-is
    }
    if (outcome === null) continue
    const { found, checked } = outcome
    try {
      const prev = await prisma.alert.findMany({
        where: { source },
        select: { target: true, severity: true, message: true },
      })
      const now = new Date().toISOString()
      const { raised, cleared } = diffAlerts(source, prev, checked, found, now)
      // Reconcile: persist found (message+severity), delete cleared.
      if (cleared.length > 0) {
        await prisma.alert.deleteMany({ where: { source, target: { in: cleared.map(c => c.target) } } })
      }
      for (const f of found) {
        await prisma.alert.upsert({
          where: { source_target: { source, target: f.target } },
          create: { source, target: f.target, message: f.message, severity: f.severity },
          update: { message: f.message, severity: f.severity },
        })
      }
      for (const evt of [...raised, ...cleared]) void dispatchEvent(evt)
    } catch (e) {
      console.error(`alert-sampler: failed to persist alerts for ${source}:`, e) // non-fatal: sampler errors must not crash the server
    }
  }
}

export function startAlertSampler(): void {
  void runChecks()
  setInterval(() => { void runChecks() }, 5 * 60_000)
}
