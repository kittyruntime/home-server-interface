// Pure helpers of the ZFS Snapshots section.
export type Snap = { name: string; dataset: string; short: string; created: number; used: number; refer: number }
export type SnapKind = 'manual' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'other'

/** Each dataset with its snapshots, newest first, and the space they hold. */
export function byDataset(snaps: Snap[], datasets: string[]) {
  return datasets.map(dataset => {
    const mine = snaps.filter(s => s.dataset === dataset).sort((a, b) => b.created - a.created)
    return { dataset, snaps: mine, used: mine.reduce((n, s) => n + s.used, 0) }
  })
}

/** Who took a snapshot: HSI by hand, an HSI schedule, or something else. */
export function snapKind(short: string): SnapKind {
  const m = /^hsi-(manual|hourly|daily|weekly|monthly)-/.exec(short)
  return m ? (m[1] as SnapKind) : 'other'
}

/** "a/b" as the breadcrumbs a, a/b. */
export function crumbs(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))
}

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
