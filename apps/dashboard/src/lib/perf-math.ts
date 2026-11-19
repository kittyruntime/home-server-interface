// Pure helpers behind the Monitor app's live graphs and process ranking.
import { formatBytes } from './file-details'

/** The top of a graph: the peak rounded up to 1, 2 or 5 times a power of ten. */
export function niceMax(values: number[], floor = 1024): number {
  const peak = Math.max(0, ...values)
  if (peak <= floor) return floor
  const pow = 10 ** Math.floor(Math.log10(peak))
  for (const step of [1, 2, 5, 10]) {
    if (peak <= step * pow) return step * pow
  }
  return 10 * pow
}

/** Appends a sample and drops the oldest past `capacity`. */
export function pushSample(history: number[], value: number, capacity: number): void {
  history.push(value)
  if (history.length > capacity) history.splice(0, history.length - capacity)
}

export interface ProcessLike {
  pid: number; name: string; user: string; cmd: string
  cpu: number; rss: number; readBps: number; writeBps: number
}

export type ProcessSort = 'name' | 'pid' | 'user' | 'cpu' | 'rss' | 'disk'

const sortValue = (p: ProcessLike, key: ProcessSort): number | string =>
  key === 'disk' ? p.readBps + p.writeBps : key === 'name' || key === 'user' ? p[key].toLowerCase() : p[key]

/** A sorted copy; equal values keep the lower pid first. */
export function sortProcesses<T extends ProcessLike>(list: T[], key: ProcessSort, dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key)
    const c = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number)
    return c !== 0 ? c * sign : a.pid - b.pid
  })
}

export function matchesProcess(p: ProcessLike, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return p.name.toLowerCase().includes(q) || p.cmd.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid) === q
}

/** Days:hours:minutes:seconds, the same in every language. */
export function fmtUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${Math.floor(s / 86400)}:${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

export function fmtRate(bps: number): string {
  return `${formatBytes(bps)}/s`
}

export function fmtGhz(mhz: number | null): string {
  return mhz && mhz > 0 ? `${(mhz / 1000).toFixed(2)} GHz` : '-'
}

/** The top of a rate graph in round KB, MB or GB, as formatBytes writes them. */
export function niceBytes(values: number[]): number {
  const peak = Math.max(0, ...values)
  if (peak <= 1024) return 1024
  const unit = 1024 ** Math.min(4, Math.floor(Math.log(peak) / Math.log(1024)))
  return niceMax(values.map(v => v / unit), 1) * unit
}

export type ProcessKind = 'system' | 'hsi' | 'app' | 'user'
export type RankMetric = 'cpu' | 'rss' | 'disk'

export interface ProcessGroup<T> {
  /** kind:owner, stable across refreshes. */
  key: string
  kind: ProcessKind
  owner: string
  cpu: number
  rss: number
  disk: number
  procs: T[]
}

/** Processes added up by who they work for: the system, HSI, each app, each account. */
export function groupProcesses<T extends ProcessLike & { kind: string; owner: string }>(list: T[]): ProcessGroup<T>[] {
  const groups = new Map<string, ProcessGroup<T>>()
  for (const p of list) {
    const key = `${p.kind}:${p.owner}`
    let g = groups.get(key)
    if (!g) groups.set(key, g = { key, kind: p.kind as ProcessKind, owner: p.owner, cpu: 0, rss: 0, disk: 0, procs: [] })
    g.cpu += p.cpu
    g.rss += p.rss
    g.disk += p.readBps + p.writeBps
    g.procs.push(p)
  }
  return [...groups.values()]
}

// Steps under which two values count as equal, so that rows do not swap
// places on every refresh: half a percent of CPU, 32 MiB of memory, 256 KiB/s of disk.
const STEP: Record<RankMetric, number> = { cpu: 0.5, rss: 32 * 1024 * 1024, disk: 256 * 1024 }

/** Ranked by a metric, highest first; near values keep their previous order. */
export function rankGroups<G extends { key: string } & Record<RankMetric, number>>(groups: G[], metric: RankMetric, previous: string[]): G[] {
  const was = new Map(previous.map((k, i) => [k, i]))
  const step = (g: G) => Math.round(g[metric] / STEP[metric])
  return [...groups].sort((a, b) =>
    step(b) - step(a) || (was.get(a.key) ?? Infinity) - (was.get(b.key) ?? Infinity) || a.key.localeCompare(b.key))
}

/** Keys ranked higher than before; newcomers do not count. */
export function climbers(previous: string[], next: string[]): string[] {
  const was = new Map(previous.map((k, i) => [k, i]))
  return next.filter((k, i) => was.has(k) && i < was.get(k)!)
}
