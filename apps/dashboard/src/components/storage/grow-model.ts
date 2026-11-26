// How a pool can grow, as the worker allows it (lot 5).
type V = { name: string; type: string; children: V[] }
export type GrowOptions = {
  /** The one layout of the data groups (null: mixed or dRAID, command line only). */
  layout: 'stripe' | 'mirror' | 'raidz1' | 'raidz2' | 'raidz3' | null
  /** Disks a new group takes (stripe: one or more). */
  width: number
  /** Groups that can take one more disk. */
  attach: Array<{ vdev: string; kind: 'mirror' | 'raidz' }>
  /** Bigger disks were put in: there is space to gain. */
  expand: boolean
}

const NOT_DATA = new Set(['log', 'cache', 'spare', 'special', 'dedup', 'logs', 'spares'])
const LAYOUTS = new Set(['mirror', 'raidz1', 'raidz2', 'raidz3'])

const atLeast = (v: string, major: number, minor: number) => {
  const [a, b] = v.split('.').map(Number)
  return a > major || (a === major && b >= minor)
}

export function growOptions(pool: { vdevs: V[]; expandSize?: number }, version: string): GrowOptions {
  const data = pool.vdevs.filter(v => !NOT_DATA.has(v.type))
  let layout: GrowOptions['layout'] = null
  let width = 0
  let mixed = false
  for (const v of data) {
    const l = v.children.length ? v.type : 'stripe'
    const w = v.children.length || 1
    if (l !== 'stripe' && !LAYOUTS.has(l)) { mixed = true; break }
    if (layout === null) { layout = l as GrowOptions['layout']; width = w } else if (l !== layout || (l !== 'stripe' && w !== width)) { mixed = true; break }
  }
  if (mixed) { layout = null; width = 0 }
  const attach = data.flatMap((v): GrowOptions['attach'] => {
    if (v.type === 'mirror' && v.children.length) return [{ vdev: v.name, kind: 'mirror' as const }]
    if (v.type.startsWith('raidz') && v.children.length && atLeast(version, 2, 3)) return [{ vdev: v.name, kind: 'raidz' as const }]
    return []
  })
  return { layout, width, attach, expand: (pool.expandSize ?? 0) > 0 }
}
