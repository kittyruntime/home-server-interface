// The Disks tab draws each disk as a bay of a chassis, colored by the engine
// that uses it. Pure helpers, tested with node (tests/disk-bays.test.ts).

import type { DiskHealth, DiskKind, DiskRole, DiskRow } from './disk-list.ts'

/** Who uses a disk: an engine (LVM today, ZFS in a later release), nobody, the
 *  system, or something HSI does not manage. */
export type BayOwner = 'lvm' | 'zfs' | 'free' | 'system' | 'other'

export type Bay = {
  name:         string
  size:         number
  owner:        BayOwner
  health:       DiskHealth
  temperature?: number
  kind:         DiskKind
  label:        string
}

export function bayOwner(role: DiskRole): BayOwner {
  switch (role) {
    case 'raid':
    case 'lvm':
    case 'mounted':   return 'lvm'
    case 'free':      return 'free'
    case 'system':    return 'system'
    case 'unmounted': return 'other'
  }
}

/** One bay per disk: the system disk first, then the others by name. */
export function bayModel(rows: DiskRow[]): Bay[] {
  return [...rows]
    .sort((a, b) => Number(b.role === 'system') - Number(a.role === 'system') || a.disk.name.localeCompare(b.disk.name, undefined, { numeric: true }))
    .map(r => ({
      name: r.disk.name,
      size: r.disk.size,
      owner: bayOwner(r.role),
      health: r.health,
      ...(r.temperature > 0 ? { temperature: r.temperature } : {}),
      kind: r.kind,
      label: r.label,
    }))
}
