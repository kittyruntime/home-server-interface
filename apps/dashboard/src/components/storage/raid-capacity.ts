// Usable capacity of an md array from its member sizes. Pure (no imports) so it
// can be unit-tested with node --test (see apps/dashboard/tests).
//
// mdadm uses the smallest member's size on every member, so larger disks
// waste the difference.

export type RaidCapacity = {
  /** Enough devices for this level (otherwise the numbers below are 0). */
  valid: boolean
  minDevices: number
  raw: number
  usable: number
  /** usable / raw, 0-100 */
  efficiency: number
  /** Drive failures the array always survives. */
  faultTolerance: number
  /** Most failures it can survive when they hit different mirrors (RAID 10). */
  maxFaultTolerance: number
  /** Bytes each member leaves unused because it is larger than the smallest. */
  wasted: number[]
}

const MIN_DEVICES: Record<string, number> = { raid0: 2, raid1: 2, raid5: 3, raid6: 4, raid10: 4 }

export function normalizeRaidLevel(level: number | string): string {
  const s = String(level).toLowerCase()
  return s.startsWith('raid') ? s : `raid${s}`
}

export function raidCapacity(level: number | string, sizes: number[]): RaidCapacity {
  const lvl = normalizeRaidLevel(level)
  const n = sizes.length
  const minDevices = MIN_DEVICES[lvl] ?? 2
  const raw = sizes.reduce((a, b) => a + b, 0)
  const empty: RaidCapacity = { valid: false, minDevices, raw, usable: 0, efficiency: 0, faultTolerance: 0, maxFaultTolerance: 0, wasted: sizes.map(() => 0) }
  if (n < minDevices || !(lvl in MIN_DEVICES)) return empty

  const smallest = Math.min(...sizes)
  let usable: number
  let faultTolerance: number
  let maxFaultTolerance: number
  switch (lvl) {
    case 'raid0':  usable = raw;                              faultTolerance = 0;     maxFaultTolerance = 0; break
    case 'raid1':  usable = smallest;                         faultTolerance = n - 1; maxFaultTolerance = n - 1; break
    case 'raid5':  usable = (n - 1) * smallest;               faultTolerance = 1;     maxFaultTolerance = 1; break
    case 'raid6':  usable = (n - 2) * smallest;               faultTolerance = 2;     maxFaultTolerance = 2; break
    default:       usable = Math.floor(n / 2) * smallest;     faultTolerance = 1;     maxFaultTolerance = Math.floor(n / 2) // raid10 near-2
  }
  // RAID 0 uses every byte of every member (mdadm stripes unequal disks in zones).
  const wasted = lvl === 'raid0' ? sizes.map(() => 0) : sizes.map(s => s - smallest)
  return {
    valid: true, minDevices, raw, usable,
    efficiency: raw > 0 ? Math.round((usable / raw) * 100) : 0,
    faultTolerance, maxFaultTolerance, wasted,
  }
}

/** Failures an array can still take in its current state (0 when degraded to the limit). */
export function remainingFaultTolerance(level: number | string, total: number, active: number): number {
  const lvl = normalizeRaidLevel(level)
  const tolerance = lvl === 'raid1' ? total - 1 : lvl === 'raid5' ? 1 : lvl === 'raid6' ? 2 : lvl === 'raid10' ? 1 : 0
  return Math.max(0, tolerance - Math.max(0, total - active))
}
