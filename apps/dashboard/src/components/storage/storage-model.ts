// Storage by function: the pools of every type in one list, the type holding
// a volume, and the facts of the overview. Pure, so it is tested alone.
import type { StorageLocation } from '../../lib/storage-nav'

export type PoolType = 'md' | 'lvm' | 'zfs'
export type PoolHealth = 'ok' | 'rebuilding' | 'degraded' | 'failed'
export type PoolRow = {
  type: PoolType
  name: string
  /** raid0..raid10 (mdadm), vg (LVM), stripe/mirror/raidz1.../mixed (ZFS) */
  layout: string
  size: number
  /** Bytes in use, when the pool knows it (an mdadm array does not). */
  used: number | null
  health: PoolHealth
  /** Percent of a rebuild, resync, check, scrub or resilver running. */
  progress?: number
  /** Disks, partitions or arrays it is built on (names without /dev/). */
  on: string[]
  holds: { kind: 'vg'; name: string } | { kind: 'volumes'; n: number } | { kind: 'datasets'; n: number } | null
  location: StorageLocation
}

type Raid = { name: string; level: string; state: string; devices: string[]; active: number; total: number; resyncPercent?: number | null }
type Dev = { name: string; size: number }
type PV = { name: string; vgName: string }
type VG = { name: string; size: number; free: number; lvCount: number }
type Vdev = { name: string; type: string; disk?: string; children: Vdev[] }
type Pool = { name: string; state: string; size: number; alloc: number; vdevs: Vdev[]; scan: { state: string; percent?: number }; expand?: { state: string; pct?: number } }

const bare = (d: string) => d.replace(/^\/dev\//, '')
const DATA_VDEV = (t: string) => !['log', 'cache', 'spare', 'special', 'dedup', 'logs', 'spares'].includes(t)

function zfsLayout(vdevs: Vdev[]): string {
  const kinds = [...new Set(vdevs.filter(v => DATA_VDEV(v.type)).map(v => (v.children.length ? v.type : 'stripe')))]
  return kinds.length === 1 ? kinds[0]! : 'mixed'
}
function leafDisks(vs: Vdev[]): string[] {
  return vs.flatMap(v => (v.children.length ? leafDisks(v.children) : [v.disk ?? bare(v.name)]))
}

export function poolRows(o: { raids: Raid[]; devices: Dev[]; pvs: PV[]; vgs: VG[]; pools: Pool[]; datasets: Array<{ pool: string }> }): PoolRow[] {
  const md: PoolRow[] = o.raids.map(r => {
    const vg = o.pvs.find(p => bare(p.name) === r.name)
    const syncing = r.resyncPercent != null
    const health: PoolHealth = r.active === 0 ? 'failed' : r.active < r.total ? 'degraded' : syncing ? 'rebuilding' : 'ok'
    return {
      type: 'md', name: r.name, layout: r.level, size: o.devices.find(d => d.name === r.name)?.size ?? 0, used: null, health,
      ...(syncing ? { progress: Math.round(r.resyncPercent!) } : {}),
      on: r.devices.map(bare), holds: vg ? { kind: 'vg', name: vg.vgName } : null, location: { kind: 'array', name: r.name },
    }
  })
  const lvm: PoolRow[] = o.vgs.map(v => ({
    type: 'lvm', name: v.name, layout: 'vg', size: v.size, used: v.size - v.free, health: 'ok',
    on: o.pvs.filter(p => p.vgName === v.name).map(p => bare(p.name)), holds: { kind: 'volumes', n: v.lvCount }, location: { kind: 'vg', name: v.name },
  }))
  const zfs: PoolRow[] = o.pools.map(p => {
    // A scrub or resilver, or a raidz being widened (OpenZFS 2.3+).
    const widening = p.expand?.state === 'running'
    const running = p.scan.state === 'running' || widening
    const percent = widening ? p.expand!.pct : p.scan.percent
    const health: PoolHealth = ['FAULTED', 'UNAVAIL', 'SUSPENDED'].includes(p.state) ? 'failed' : p.state !== 'ONLINE' ? 'degraded' : running ? 'rebuilding' : 'ok'
    return {
      type: 'zfs', name: p.name, layout: zfsLayout(p.vdevs), size: p.size, used: p.alloc, health,
      ...(running && percent != null ? { progress: Math.round(percent) } : {}),
      on: leafDisks(p.vdevs.filter(v => DATA_VDEV(v.type))), holds: { kind: 'datasets', n: o.datasets.filter(d => d.pool === p.name).length },
      location: { kind: 'pool', name: p.name },
    }
  })
  return [...md, ...lvm, ...zfs]
}

/** The type holding a volume: ZFS, LVM (whatever is under it), an mdadm
 *  array alone, or a plain partition or disk. */
export function volumeType(v: { engine?: string; stack: Array<{ kind: string }> }): PoolType | 'plain' {
  if (v.engine === 'zfs' || v.stack.some(l => l.kind === 'dataset' || l.kind === 'pool')) return 'zfs'
  if (v.stack.some(l => l.kind === 'lv' || l.kind === 'vg')) return 'lvm'
  if (v.stack.some(l => l.kind === 'array')) return 'md'
  return 'plain'
}

export function storageFacts(o: {
  disks: Array<{ health: string }>
  rows: PoolRow[]
  volumes: Array<{ state: string; engine?: string; space?: { total: number; used: number }; issues: unknown[] }>
}) {
  const mounted = o.volumes.filter(v => v.state === 'mounted')
  // ZFS datasets share their pool's free space: the pools count once each,
  // the other volumes by their own filesystem.
  const zfs = o.rows.filter(r => r.type === 'zfs')
  const own = mounted.filter(v => v.engine !== 'zfs')
  const checked = o.disks.filter(d => d.health !== 'unknown')
  return {
    disks: o.disks.length,
    checkedDisks: checked.length,
    healthyDisks: checked.filter(d => d.health === 'ok').length,
    /** Not read yet: asleep (never woken for this) or SMART not available. */
    uncheckedDisks: o.disks.length - checked.length,
    pools: o.rows.length,
    volumes: o.volumes.length,
    mounted: mounted.length,
    capacity: [
      ...own.map(v => ({ total: v.space?.total ?? 0, used: v.space?.used ?? 0 })),
      ...zfs.map(r => ({ total: r.size, used: r.used ?? 0 })),
    ].reduce((c, x) => ({ total: c.total + x.total, used: c.used + x.used }), { total: 0, used: 0 }),
    running: o.rows.filter(r => r.progress != null),
    troubled: o.rows.filter(r => r.health === 'degraded' || r.health === 'failed'),
  }
}
