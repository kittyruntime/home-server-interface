// How a volume is built, read from its disks up to its folder. The backend
// lists a volume's layers top down (filesystem, lv, vg, arrays, partitions,
// disks: services/volumes.ts); this turns them into the steps the LVM tab
// draws. Pure, tested with node (tests/stack-chain.test.ts).

export type StackLayer = { kind: 'filesystem' | 'partition' | 'lv' | 'vg' | 'array' | 'disk'; name: string }
export type ChainStep = { kind: 'disks' | 'array' | 'vg' | 'filesystem' | 'mount'; names: string[] }

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

export function chainOf(v: { stack: StackLayer[]; mountPoint?: string; fstype?: string }): ChainStep[] {
  if (!v.stack.length) return []
  const names = (kind: StackLayer['kind']) => v.stack.filter(l => l.kind === kind).map(l => l.name).sort(byName)
  const steps: ChainStep[] = []
  const push = (kind: ChainStep['kind'], list: string[]) => { if (list.length) steps.push({ kind, names: list }) }
  push('disks', names('disk'))
  push('array', names('array'))
  push('vg', names('vg'))
  push('filesystem', v.fstype ? [v.fstype] : [])
  push('mount', v.mountPoint ? [v.mountPoint] : [])
  return steps
}
