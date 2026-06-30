import * as os from "os"
import * as fs from "fs"
import { prisma } from "@app/database"

let cpuPrev: { idle: number; total: number }[] | null = null

function sampleCpu(): number {
  const cpus = os.cpus()
  const current = cpus.map(c => {
    const vals = Object.values(c.times)
    const total = vals.reduce((a, b) => a + b, 0)
    return { idle: c.times.idle, total }
  })
  if (!cpuPrev) { cpuPrev = current; return 0 }
  let idleDelta = 0, totalDelta = 0
  for (let i = 0; i < current.length; i++) {
    idleDelta  += current[i]!.idle  - (cpuPrev[i]?.idle  ?? 0)
    totalDelta += current[i]!.total - (cpuPrev[i]?.total ?? 0)
  }
  cpuPrev = current
  return totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0
}

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

let prevNet: { data: Record<string, { rx: number; tx: number }>; ts: number } | null = null

function sampleNet(): { rx: number; tx: number } {
  const now = Date.now()
  const current = parseNetDev()

  if (!prevNet || Object.keys(prevNet.data).length === 0) {
    prevNet = { data: current, ts: now }
    return { rx: 0, tx: 0 }
  }

  const dt = (now - prevNet.ts) / 1000
  if (dt <= 0) return { rx: 0, tx: 0 }

  let rxDelta = 0, txDelta = 0
  for (const [iface, vals] of Object.entries(current)) {
    if (iface === "lo") continue
    const prev = prevNet.data[iface]
    if (!prev) continue
    rxDelta += Math.max(0, vals.rx - prev.rx)
    txDelta += Math.max(0, vals.tx - prev.tx)
  }

  prevNet = { data: current, ts: now }
  return {
    rx: Math.round(rxDelta / dt),
    tx: Math.round(txDelta / dt),
  }
}

export function startMetricsSampler(): void {
  // warm up CPU and net counters
  sampleCpu()
  sampleNet()

  setInterval(async () => {
    try {
      const cpu  = sampleCpu()
      const mem  = os.totalmem()
      const free = os.freemem()
      const net  = sampleNet()
      await prisma.metricSnapshot.create({
        data: {
          cpuPct:   cpu,
          ramUsed:  mem - free,
          ramTotal: mem,
          netRxBps: net.rx,
          netTxBps: net.tx,
          uptime:   Math.floor(os.uptime()),
        },
      })
      // purge snapshots older than 30 days
      await prisma.metricSnapshot.deleteMany({
        where: { timestamp: { lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
      })
    } catch (e) {
      // non-fatal: sampler errors must not crash the server
      console.error("[metrics-sampler]", e)
    }
  }, 60_000)
}
