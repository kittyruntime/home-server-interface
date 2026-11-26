// A ZFS pool drawn as a tree, one row per node: the pool, its vdevs, their
// disks. Pure, tested with node (tests/zfs-model.test.ts).

export type TopoVdev = { name: string; type: string; state: string; disk?: string; read: number; write: number; checksum: number; children: TopoVdev[] }
/** `leaf`: a disk's name as zpool knows it (its path, or its guid when missing). */
export type TopoNode = { label: string; kind: 'pool' | 'vdev' | 'disk'; type: string; state: string; errors: number; depth: number; leaf?: string }

export function topology(p: { name: string; state: string; vdevs: TopoVdev[] }): TopoNode[] {
  const rows: TopoNode[] = [{ label: p.name, kind: 'pool', type: 'pool', state: p.state, errors: 0, depth: 0 }]
  const walk = (v: TopoVdev, depth: number) => {
    const leaf = v.children.length === 0
    rows.push({
      label: leaf ? v.disk || v.name.replace(/^\/dev\//, '') : v.name,
      kind: leaf ? 'disk' : 'vdev', type: v.type, state: v.state,
      errors: v.read + v.write + v.checksum, depth,
      ...(leaf ? { leaf: v.name } : {}),
    })
    for (const c of v.children) walk(c, depth + 1)
  }
  for (const v of p.vdevs) walk(v, 1)
  return rows
}
