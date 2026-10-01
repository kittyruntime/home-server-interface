// Pure helpers of the Create volume wizard (#40). No Vue or tRPC imports.

export type Level = 'none' | 'raid1' | 'raid5' | 'raid6' | 'raid10'

const MIN_DISKS: Record<Exclude<Level, 'none'>, number> = { raid1: 2, raid5: 3, raid6: 4, raid10: 4 }

/** Levels possible with `n` disks, redundant ones first. */
export function possibleLevels(n: number): Level[] {
  const redundant = (Object.keys(MIN_DISKS) as Array<Exclude<Level, 'none'>>).filter(l => n >= MIN_DISKS[l])
  return [...redundant, 'none']
}

/** Usable bytes: arrays size every member to the smallest disk. */
export function usableBytes(level: Level, sizes: number[]): number {
  if (!sizes.length) return 0
  const min = Math.min(...sizes)
  const n = sizes.length
  switch (level) {
    case 'raid1':  return min
    case 'raid5':  return (n - 1) * min
    case 'raid6':  return (n - 2) * min
    case 'raid10': return Math.floor(n / 2) * min
    default:       return sizes.reduce((a, b) => a + b, 0)
  }
}

/** Disks that may fail without losing the volume. */
export function tolerance(level: Level, n: number): number {
  switch (level) {
    case 'raid1':  return n - 1
    case 'raid5':  return 1
    case 'raid6':  return 2
    case 'raid10': return 1
    default:       return 0
  }
}

/** A name not used by a volume group nor by a folder under /srv. */
export function proposeName(vgNames: string[], mountPoints: string[]): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? 'data' : `data${i}`
    if (!vgNames.includes(name) && !mountPoints.includes(mountFor(name))) return name
  }
}

export function mountFor(name: string): string {
  return `/srv/${name}`
}
