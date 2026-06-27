import * as os from "os"
import * as fs from "fs"
import { router, protectedProcedure, adminProcedure } from "../index"
import { requestSync } from "../../nats"

// --- CPU delta ---
let cpuPrev: { idle: number; total: number }[] | null = null

function cpuPercent(): number {
  const cpus = os.cpus()
  const current = cpus.map(c => {
    const t = Object.values(c.times).reduce((a, b) => a + b, 0)
    return { idle: c.times.idle, total: t }
  })

  if (!cpuPrev) {
    cpuPrev = current
    return 0
  }

  let idleDelta = 0
  let totalDelta = 0
  for (let i = 0; i < current.length; i++) {
    idleDelta  += current[i]!.idle  - (cpuPrev[i]?.idle  ?? 0)
    totalDelta += current[i]!.total - (cpuPrev[i]?.total ?? 0)
  }
  cpuPrev = current

  if (totalDelta === 0) return 0
  const used = totalDelta - idleDelta
  return Math.min(100, Math.max(0, Math.round((used / totalDelta) * 100)))
}

// --- Network delta (/proc/net/dev) ---
let netPrev: Record<string, { rx: number; tx: number }> | null = null
let netPrevMs = 0

function parseNetDev(): Record<string, { rx: number; tx: number }> {
  try {
    const content = fs.readFileSync("/proc/net/dev", "utf8")
    const result: Record<string, { rx: number; tx: number }> = {}
    for (const line of content.split("\n").slice(2)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [iface, rest] = trimmed.split(":")
      if (!iface || !rest) continue
      const cols = rest.trim().split(/\s+/)
      result[iface.trim()] = {
        rx: parseInt(cols[0] ?? "0", 10),
        tx: parseInt(cols[8] ?? "0", 10),
      }
    }
    return result
  } catch {
    return {}
  }
}

function netRates(): { rx: number; tx: number } {
  const now = Date.now()
  const current = parseNetDev()

  if (!netPrev || Object.keys(netPrev).length === 0) {
    netPrev  = current
    netPrevMs = now
    return { rx: 0, tx: 0 }
  }

  const dt = (now - netPrevMs) / 1000
  if (dt <= 0) return { rx: 0, tx: 0 }

  let rxDelta = 0
  let txDelta = 0
  for (const [iface, vals] of Object.entries(current)) {
    if (iface === "lo") continue
    const prev = netPrev[iface]
    if (!prev) continue
    rxDelta += Math.max(0, vals.rx - prev.rx)
    txDelta += Math.max(0, vals.tx - prev.tx)
  }

  netPrev  = current
  netPrevMs = now

  return {
    rx: Math.round(rxDelta / dt),
    tx: Math.round(txDelta / dt),
  }
}

// --- Memory ---
function memoryInfo(): { total: number; used: number; percent: number } {
  const total = os.totalmem()
  const free  = os.freemem()
  const used  = total - free
  return {
    total,
    used,
    percent: Math.round((used / total) * 100),
  }
}

// --- Router ---
export const systemRouter = router({
  metrics: protectedProcedure.query(() => {
    return {
      cpu:     cpuPercent(),
      memory:  memoryInfo(),
      network: netRates(),
      uptime:  Math.floor(os.uptime()),
    }
  }),

  disks: adminProcedure.query(async () => {
    return await requestSync<{
      disks: Array<{ device: string; mountPoint: string; fsType: string; total: number; used: number; free: number }>
      raids: Array<{ name: string; level: string; state: string; devices: string[]; active: number; total: number }>
    }>("root.sys.disks", {})
  }),
})
