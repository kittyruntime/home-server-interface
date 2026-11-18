// Pure helpers behind the Monitor app's live graphs and process table.
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

/** Shade step 0 to 4 for a usage cell, from a percentage of the machine. */
export function heat(pct: number): 0 | 1 | 2 | 3 | 4 {
  if (pct <= 0) return 0
  if (pct < 5) return 1
  if (pct < 15) return 2
  if (pct < 50) return 3
  return 4
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
