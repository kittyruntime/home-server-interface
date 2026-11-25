import type { Redundancy, StackLayer, Volume, VolumeInput, VolumeIssue } from './volumes'

// ZFS (lot 1): what the worker reads from zpool and zfs (root.zfs.list), and
// the volumes its datasets make. A dataset ZFS mounts on a folder of its own is
// a volume like any other; the pool is the layer under it. No I/O here.

export type ZfsVdev = {
  name: string
  type: string
  state: string
  path?: string
  disk?: string
  read: number
  write: number
  checksum: number
  children: ZfsVdev[]
}
export type ZfsScan = { kind: string; state: string; end?: string; repaired: number; errors: number; percent?: number }
export type ZfsPool = {
  name: string; guid: string; state: string; size: number; alloc: number; free: number; frag: number
  vdevs: ZfsVdev[]; scan: ZfsScan
}
export type ZfsDataset = {
  name: string; pool: string; mountPoint: string; compression: string
  /** on, off or noauto; absent from workers before it was read. */
  canMount?: string
  used: number; avail: number; quota: number; mounted: boolean; ratio: number
}
export type ZfsInfo = {
  available: boolean
  version: string
  /** The distribution's units importing and mounting pools at boot. */
  bootUnits?: { importCache: boolean; mount: boolean }
  pools: ZfsPool[]
  datasets: ZfsDataset[]
  watched: Array<{ name: string; guid: string; datasets: Array<{ name: string; mountPoint: string }> }>
}

export const NO_ZFS: ZfsInfo = { available: false, version: '', pools: [], datasets: [], watched: [] }

// Vdevs that hold data: not logs, caches or spares.
const DATA_TYPES = new Set(['mirror', 'raidz1', 'raidz2', 'raidz3', 'draid', 'disk'])
const NEARLY_FULL = 0.9

export function leavesOf(v: ZfsVdev): ZfsVdev[] {
  return v.children.length ? v.children.flatMap(leavesOf) : [v]
}

/** A pool is as redundant as its weakest data vdev. */
export function poolRedundancy(p: ZfsPool): { level: Redundancy; tolerates: number } {
  const data = p.vdevs.filter(v => DATA_TYPES.has(v.type))
  if (!data.length) return { level: 'none', tolerates: 0 }
  const one = (v: ZfsVdev): { level: Redundancy; tolerates: number } => {
    switch (v.type) {
      case 'mirror': return { level: 'raid1', tolerates: Math.max(0, v.children.length - 1) }
      case 'raidz1': return { level: 'raidz1', tolerates: 1 }
      case 'raidz2': return { level: 'raidz2', tolerates: 2 }
      case 'raidz3': return { level: 'raidz3', tolerates: 3 }
      default: return { level: 'none', tolerates: 0 }
    }
  }
  const weakest = data.map(one).reduce((a, b) => (b.tolerates < a.tolerates ? b : a))
  // Disks striped with nothing else: the data is spread, one failure loses it.
  if (weakest.tolerates === 0) return { level: data.length > 1 ? 'raid0' : 'none', tolerates: 0 }
  return weakest
}

/** A dataset ZFS mounts on a folder of its own by itself (canmount=on). */
export function isVolumeDataset(d: ZfsDataset): boolean {
  return d.mountPoint.startsWith('/') && (d.canMount ?? 'on') === 'on'
}

export const zfsVolumeId = (guid: string, dataset: string) => `zfs:${guid}:${dataset}`

function poolIssues(p: ZfsPool): VolumeIssue[] {
  const issues: VolumeIssue[] = []
  if (p.state === 'DEGRADED') issues.push({ kind: 'degraded', text: `Pool ${p.name} is degraded` })
  else if (p.state !== 'ONLINE') issues.push({ kind: 'missing', text: `Pool ${p.name} is ${p.state.toLowerCase()}` })
  if (p.scan.kind === 'resilver' && p.scan.state === 'running')
    issues.push({ kind: 'rebuilding', text: `${p.name} is resilvering${p.scan.percent != null ? ` (${Math.round(p.scan.percent)}%)` : ''}` })
  return issues
}

/** The volumes of the datasets HSI can use: one per dataset with a folder. */
export function zfsVolumes(zfs: ZfsInfo, guard: VolumeInput['guard'], holds: VolumeInput['holds']): Volume[] {
  const out: Volume[] = []
  for (const d of zfs.datasets) {
    if (!isVolumeDataset(d)) continue
    const pool = zfs.pools.find(p => p.name === d.pool)
    if (!pool) continue
    const id = zfsVolumeId(pool.guid, d.name)
    const red = poolRedundancy(pool)
    const dataVdevs = pool.vdevs.filter(v => DATA_TYPES.has(v.type))
    const disks = [...new Set(dataVdevs.flatMap(leavesOf).map(l => l.disk).filter((x): x is string => !!x))].sort()
    const stack: StackLayer[] = [
      { kind: 'filesystem', name: d.mountPoint },
      { kind: 'dataset', name: d.name },
      { kind: 'pool', name: pool.name },
      ...dataVdevs.filter(v => v.children.length).map(v => ({ kind: 'vdev' as const, name: v.name })),
      ...disks.map(name => ({ kind: 'disk' as const, name })),
    ]
    const issues = poolIssues(pool)
    const g = guard.find(x => x.uuid === id) ?? guard.find(x => x.mountPoint === d.mountPoint)
    if (g && (g.state === 'wrong' || g.state === 'readonly'))
      issues.push({ kind: 'blocked', text: g.state === 'readonly' ? 'Mounted read-only' : 'Another device is mounted there' })
    const hold = holds.find(h => h.mountPoint === d.mountPoint)
    if (hold && !issues.some(i => i.kind === 'blocked' || i.kind === 'missing'))
      issues.push({ kind: 'blocked', text: hold.status === 'back' ? 'Back online, waiting for Resume' : hold.reason })
    const total = d.used + d.avail
    const space = d.mounted && total > 0 ? { total, used: d.used, free: d.avail } : undefined
    if (space && space.used / space.total > NEARLY_FULL)
      issues.push({ kind: 'nearly-full', text: `${Math.round((space.used / space.total) * 100)}% full` })
    out.push({
      id,
      name: d.name.includes('/') ? d.name.slice(d.name.lastIndexOf('/') + 1) : d.name,
      state: d.mounted ? 'mounted' : 'not-mounted',
      device: d.name,
      fstype: 'zfs',
      mountPoint: d.mounted ? d.mountPoint : undefined,
      ...(!d.mounted ? { expectedMountPoint: d.mountPoint } : {}),
      redundancy: red.level,
      tolerates: red.tolerates,
      stack,
      disks: disks.map(name => ({ name, model: '' })),
      space,
      issues,
      usedBy: { places: [], shares: [], apps: [] },
      engine: 'zfs',
    })
  }
  return out
}
