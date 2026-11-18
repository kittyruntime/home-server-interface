import * as os from "os"
import * as fs from "fs"
import { requestSync } from "../nats"

// Live performance for the Monitor app: per core CPU, memory detail, each disk
// and each network port, plus the process list. Rates come from the difference
// between two readings; one shared reading serves every viewer so that several
// open windows do not shorten each other's measuring window.

const round1 = (n: number) => Math.round(n * 10) / 10

// ── CPU ──────────────────────────────────────────────────────────────────────

export interface CpuTimes { total: number; idle: number }

/** /proc/stat: the machine total first, then one entry per core. */
export function parseCpuTimes(stat: string): CpuTimes[] {
  const out: CpuTimes[] = []
  for (const line of stat.split("\n")) {
    if (!/^cpu\d*\s/.test(line)) continue
    const v = line.trim().split(/\s+/).slice(1, 9).map(Number)
    const total = v.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
    out.push({ total, idle: (v[3] ?? 0) + (v[4] ?? 0) })
  }
  return out
}

/** Busy percent per entry between two readings. */
export function cpuBusy(prev: CpuTimes[], cur: CpuTimes[]): number[] {
  return cur.map((c, i) => {
    const p = prev[i]
    const total = c.total - (p?.total ?? 0)
    if (!p || total <= 0) return 0
    return round1(Math.min(100, Math.max(0, ((total - (c.idle - p.idle)) / total) * 100)))
  })
}

// ── Memory ───────────────────────────────────────────────────────────────────

export interface MemoryDetail {
  total: number; available: number; used: number; cached: number; buffers: number; free: number
  swapTotal: number; swapUsed: number
}

export function parseMeminfo(text: string): MemoryDetail {
  const kb: Record<string, number> = {}
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line)
    if (m) kb[m[1]!] = Number(m[2]) * 1024
  }
  const total = kb.MemTotal ?? 0
  const available = kb.MemAvailable ?? kb.MemFree ?? 0
  return {
    total, available, used: Math.max(0, total - available),
    cached: (kb.Cached ?? 0) + (kb.SReclaimable ?? 0), buffers: kb.Buffers ?? 0, free: kb.MemFree ?? 0,
    swapTotal: kb.SwapTotal ?? 0, swapUsed: Math.max(0, (kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0)),
  }
}

// ── Disks ────────────────────────────────────────────────────────────────────

export interface DiskCounters { read: number; write: number; ioMs: number }

/** A physical disk, not a partition, an array, a mapper or an optical drive. */
export function isWholeDisk(name: string): boolean {
  return /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name)
}

/** /proc/diskstats in bytes (sectors are always 512 bytes there). */
export function parseDiskstats(text: string): Record<string, DiskCounters> {
  const out: Record<string, DiskCounters> = {}
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/)
    const name = f[2]
    if (!name || f.length < 13 || !isWholeDisk(name)) continue
    out[name] = { read: Number(f[5]) * 512, write: Number(f[9]) * 512, ioMs: Number(f[12]) }
  }
  return out
}

export function diskRates(prev: DiskCounters, cur: DiskCounters, dtMs: number) {
  const s = dtMs / 1000
  if (s <= 0) return { readBps: 0, writeBps: 0, busy: 0 }
  return {
    readBps: Math.round(Math.max(0, cur.read - prev.read) / s),
    writeBps: Math.round(Math.max(0, cur.write - prev.write) / s),
    busy: round1(Math.min(100, Math.max(0, ((cur.ioMs - prev.ioMs) / dtMs) * 100))),
  }
}

// ── Network ──────────────────────────────────────────────────────────────────

export function parseNetDev(text: string): Record<string, { rx: number; tx: number }> {
  const out: Record<string, { rx: number; tx: number }> = {}
  for (const line of text.split("\n").slice(2)) {
    const [iface, rest] = line.split(":")
    if (!iface?.trim() || !rest) continue
    const cols = rest.trim().split(/\s+/)
    out[iface.trim()] = { rx: Number(cols[0] ?? 0), tx: Number(cols[8] ?? 0) }
  }
  return out
}

// ── Processes ────────────────────────────────────────────────────────────────

/** One process as the root worker reports it. */
export interface RawProcess {
  pid: number; ppid: number; name: string; cmd: string; user: string; state: string
  ticks: number; threads: number; rss: number; start: string; read: number; write: number; protected: boolean
}

export interface ProcessRow extends Omit<RawProcess, "ticks" | "read" | "write"> {
  /** Share of the whole machine, like the CPU graph. */
  cpu: number
  readBps: number
  writeBps: number
}

type Seen = Map<string, { ticks: number; read: number; write: number }>

/** /proc counts process time in USER_HZ, which Linux fixes at 100. */
const USER_HZ = 100

export function processRates(seen: Seen, list: RawProcess[], dtSec: number, cores: number): { rows: ProcessRow[]; seen: Seen } {
  const next: Seen = new Map()
  const rows = list.map(({ ticks, read, write, ...p }) => {
    const key = `${p.pid}:${p.start}`
    next.set(key, { ticks, read, write })
    const prev = seen.get(key)
    const ok = prev && dtSec > 0
    return {
      ...p,
      cpu: ok ? round1(Math.min(100, Math.max(0, ((ticks - prev.ticks) / USER_HZ / dtSec / Math.max(1, cores)) * 100))) : 0,
      readBps: ok ? Math.round(Math.max(0, read - prev.read) / dtSec) : 0,
      writeBps: ok ? Math.round(Math.max(0, write - prev.write) / dtSec) : 0,
    }
  })
  return { rows, seen: next }
}

// ── Sampling ─────────────────────────────────────────────────────────────────

const read = (p: string) => { try { return fs.readFileSync(p, "utf8") } catch { return "" } }
const sysNum = (p: string) => { const n = Number(read(p).trim()); return Number.isFinite(n) ? n : null }

interface Reading { at: number; cpu: CpuTimes[]; disks: Record<string, DiskCounters>; net: Record<string, { rx: number; tx: number }> }

function takeReading(): Reading {
  return { at: Date.now(), cpu: parseCpuTimes(read("/proc/stat")), disks: parseDiskstats(read("/proc/diskstats")), net: parseNetDev(read("/proc/net/dev")) }
}

/** Ports worth showing: real hardware and bonds, not loopback, bridges or container links. */
function shownPort(name: string): boolean {
  return name !== "lo" && (fs.existsSync(`/sys/class/net/${name}/device`) || /^bond\d+$/.test(name))
}

function countProcesses(): number {
  try { return fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)).length } catch { return 0 }
}

function buildPerf(prev: Reading, cur: Reading) {
  const dt = cur.at - prev.at
  const busy = cpuBusy(prev.cpu, cur.cpu)
  const cpus = os.cpus()
  const loadavg = read("/proc/loadavg").trim().split(/\s+/)
  const threads = Number(loadavg[3]?.split("/")[1] ?? 0)
  const addrs = os.networkInterfaces()
  return {
    at: cur.at,
    uptime: Math.floor(os.uptime()),
    cpu: {
      model: cpus[0]?.model?.replace(/\s+/g, " ").trim() ?? "",
      cores: cpus.length,
      usage: busy[0] ?? 0,
      perCore: busy.slice(1),
      mhz: cpus.length ? Math.round(cpus.reduce((a, c) => a + c.speed, 0) / cpus.length) : 0,
      maxMhz: (() => { const k = sysNum("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq"); return k ? Math.round(k / 1000) : null })(),
      loadavg: os.loadavg() as [number, number, number],
      processes: countProcesses(),
      threads: Number.isFinite(threads) ? threads : 0,
    },
    memory: parseMeminfo(read("/proc/meminfo")),
    disks: Object.entries(cur.disks).map(([name, c]) => {
      const sectors = sysNum(`/sys/block/${name}/size`)
      return {
        name,
        model: read(`/sys/block/${name}/device/model`).trim() || null,
        size: sectors === null ? null : sectors * 512,
        rotational: sysNum(`/sys/block/${name}/queue/rotational`) === 1,
        ...diskRates(prev.disks[name] ?? c, c, dt),
      }
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    nets: Object.entries(cur.net).filter(([name]) => shownPort(name)).map(([name, c]) => {
      const p = prev.net[name] ?? c
      const speed = sysNum(`/sys/class/net/${name}/speed`)
      return {
        name,
        rxBps: dt > 0 ? Math.round(Math.max(0, c.rx - p.rx) / (dt / 1000)) : 0,
        txBps: dt > 0 ? Math.round(Math.max(0, c.tx - p.tx) / (dt / 1000)) : 0,
        up: read(`/sys/class/net/${name}/operstate`).trim() === "up",
        speedMbps: speed && speed > 0 ? speed : null,
        mac: read(`/sys/class/net/${name}/address`).trim() || null,
        addrs: (addrs[name] ?? []).filter(a => !a.internal).map(a => ({ addr: a.address, family: a.family as string })),
      }
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  }
}

export type Perf = ReturnType<typeof buildPerf>

/** Readings closer than this are served from the last one. */
const MIN_WINDOW_MS = 1000
let base: Reading | null = null
let last: Perf | null = null

export function perfSnapshot(): Perf {
  const now = Date.now()
  if (last && base && now - last.at < MIN_WINDOW_MS) return last
  const cur = takeReading()
  // The first call has nothing to compare against: measure over a short pause.
  const prev = base ?? (() => { const r = takeReading(); r.at = now - MIN_WINDOW_MS; return r })()
  last = buildPerf(prev, cur)
  base = cur
  return last
}

let seen: Seen = new Map()
let procAt = 0
let procLast: ProcessRow[] | null = null

export async function processSnapshot(): Promise<ProcessRow[]> {
  const now = Date.now()
  if (procLast && now - procAt < MIN_WINDOW_MS) return procLast
  const list = await requestSync<RawProcess[]>("root.process.list", {}, 15_000)
  const r = processRates(seen, list, procAt ? (now - procAt) / 1000 : 0, os.cpus().length)
  seen = r.seen
  procAt = now
  procLast = r.rows
  return r.rows
}

export async function endProcess(pid: number, start: string, force: boolean) {
  await requestSync("root.process.kill", { pid, start, force })
  procLast = null
}
