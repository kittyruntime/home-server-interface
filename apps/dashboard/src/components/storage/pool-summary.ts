// One line for a pool's layout and one for its last scrub or resilver.
// Pure, tested with node (tests/zfs-model.test.ts).

type V = { type: string; children: V[] }
const DATA = new Set(['mirror', 'raidz1', 'raidz2', 'raidz3', 'draid', 'disk'])
const leaves = (v: V): number => (v.children.length ? v.children.reduce((n, c) => n + leaves(c), 0) : 1)

/** "mirror · 2 disks", "2 × raidz2 · 8 disks", "stripe · 3 disks". */
export function layoutOf(vdevs: V[]): { kind: string; groups: number; disks: number } {
  const data = vdevs.filter(v => DATA.has(v.type))
  const kinds = [...new Set(data.map(v => (v.type === 'disk' ? 'stripe' : v.type)))]
  const groups = data.filter(v => v.type !== 'disk').length
  return { kind: kinds.length === 1 ? kinds[0]! : 'mixed', groups, disks: data.reduce((n, v) => n + leaves(v), 0) }
}

export type ScanLine =
  | { kind: 'never' }
  | { kind: 'running'; what: 'scrub' | 'resilver'; percent: number | null }
  | { kind: 'done'; what: 'scrub' | 'resilver'; end: string; errors: number }
  | { kind: 'canceled'; what: 'scrub' | 'resilver'; end: string }

export function scanLine(s: { kind: string; state: string; end?: string; errors: number; percent?: number }): ScanLine {
  const what = s.kind === 'resilver' ? 'resilver' : 'scrub'
  if (s.kind === 'none' || s.state === 'none') return { kind: 'never' }
  if (s.state === 'running') return { kind: 'running', what, percent: s.percent ?? null }
  if (s.state === 'canceled') return { kind: 'canceled', what, end: s.end ?? '' }
  return { kind: 'done', what, end: s.end ?? '', errors: s.errors }
}

/** Watched pools that are not imported now: shown so they can be unwatched. */
export function missingWatched<W extends { guid: string }>(watched: W[], pools: Array<{ guid: string }>): W[] {
  const imported = new Set(pools.map(p => p.guid))
  return watched.filter(w => !imported.has(w.guid))
}
