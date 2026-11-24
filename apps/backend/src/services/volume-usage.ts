import { prisma } from '@app/database'
import { requestSync } from '../nats'
import { buildVolumes, type VDev, type VolumeInput } from './volumes'
import { log } from '../utils/log'

// Space used on each volume over time, for the "full in about n months"
// estimate. One sample an hour, kept 180 days.

const DAY = 86_400_000
export type UsagePoint = { t: number; used: number; total: number }
export type Forecast = { perDay: number; daysLeft: number | null; spanDays: number; used: number; total: number }

/** Least-squares growth over the samples; null under a day of history. */
export function forecast(points: UsagePoint[]): Forecast | null {
  if (points.length < 2) return null
  const sorted = [...points].sort((a, b) => a.t - b.t)
  const first = sorted[0]!, last = sorted[sorted.length - 1]!
  const spanDays = (last.t - first.t) / DAY
  if (spanDays < 1) return null
  const xs = sorted.map(p => (p.t - first.t) / DAY), ys = sorted.map(p => p.used)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0, den = 0
  for (let i = 0; i < xs.length; i++) { num += (xs[i]! - mx) * (ys[i]! - my); den += (xs[i]! - mx) ** 2 }
  const perDay = den > 0 ? num / den : 0
  const free = Math.max(0, last.total - last.used)
  // Growth under 1 MB a day is noise (logs, caches): no date.
  const daysLeft = perDay > 1_048_576 ? free / perDay : null
  return { perDay: Math.round(perDay), daysLeft: daysLeft == null ? null : Math.round(daysLeft), spanDays: Math.round(spanDays * 10) / 10, used: last.used, total: last.total }
}

async function sample(): Promise<void> {
  const block = await requestSync<{ devices: VDev[]; raids: VolumeInput['raids'] }>('root.sys.blockdevices', {}, 15_000)
  const { volumes } = buildVolumes({
    devices: block.devices ?? [], raids: block.raids ?? [], lvm: { pvs: [], vgs: [], lvs: [] },
    guard: [], holds: [], places: [], shares: [], apps: [],
  })
  const rows = volumes.filter(v => v.space && v.space.total > 0)
    .map(v => ({ volumeId: v.id, used: BigInt(Math.round(v.space!.used)), total: BigInt(Math.round(v.space!.total)) }))
  if (rows.length) await prisma.volumeUsageSample.createMany({ data: rows })
  await prisma.volumeUsageSample.deleteMany({ where: { timestamp: { lt: new Date(Date.now() - 180 * DAY) } } })
}

export function startVolumeUsageSampler(): void {
  const run = () => sample().catch(e => log.warn({ err: e }, 'volume-usage sampler failed'))
  setTimeout(run, 90_000)
  setInterval(run, 3_600_000)
}

/** The estimate for every volume with samples in the last 30 days. */
export async function volumeForecasts(): Promise<Record<string, Forecast>> {
  const rows = await prisma.volumeUsageSample.findMany({
    where: { timestamp: { gte: new Date(Date.now() - 30 * DAY) } },
    orderBy: { timestamp: 'asc' },
  })
  const by = new Map<string, UsagePoint[]>()
  for (const r of rows) {
    const list = by.get(r.volumeId) ?? []
    list.push({ t: r.timestamp.getTime(), used: Number(r.used), total: Number(r.total) })
    by.set(r.volumeId, list)
  }
  const out: Record<string, Forecast> = {}
  for (const [id, pts] of by) { const f = forecast(pts); if (f) out[id] = f }
  return out
}
