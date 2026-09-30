// Where the Storage app is (#40): a section, or an object shown in its
// section. Each Storage panel keeps its own stack of locations.

export type StorageSection = 'disks' | 'raid' | 'lvm' | 'mounts' | 'maintenance'
export type StorageLocation =
  | { kind: 'section'; section: StorageSection }
  | { kind: 'disk'; name: string }
  | { kind: 'array'; name: string }
  | { kind: 'vg'; name: string }

export const SECTION_LABELS: Record<StorageSection, string> = {
  disks: 'Devices', raid: 'RAID', lvm: 'LVM', mounts: 'Mounts', maintenance: 'Maintenance',
}

export function sectionOf(loc: StorageLocation): StorageSection {
  switch (loc.kind) {
    case 'section': return loc.section
    case 'disk':    return 'disks'
    case 'array':   return 'raid'
    case 'vg':      return 'lvm'
  }
}

export function locationLabel(loc: StorageLocation): string {
  return loc.kind === 'section' ? SECTION_LABELS[loc.section] : loc.name
}

export interface StorageNav { stack: StorageLocation[]; current: StorageLocation }

const same = (a: StorageLocation, b: StorageLocation) => JSON.stringify(a) === JSON.stringify(b)
const make = (stack: StorageLocation[]): StorageNav => ({ stack, current: stack[stack.length - 1]! })

export function createNav(initial: StorageLocation = { kind: 'section', section: 'disks' }): StorageNav {
  return navOpen(make([{ kind: 'section', section: sectionOf(initial) }]), initial)
}

export function navOpen(nav: StorageNav, loc: StorageLocation): StorageNav {
  if (loc.kind === 'section') return make([loc])
  if (same(nav.current, loc)) return nav
  const base: StorageLocation = { kind: 'section', section: sectionOf(loc) }
  // Opening an object from another section starts from that section.
  const stack = sectionOf(nav.current) === base.section ? nav.stack : [base]
  return make([...stack, loc])
}

export function navBack(nav: StorageNav): StorageNav {
  return nav.stack.length > 1 ? make(nav.stack.slice(0, -1)) : nav
}

export function navCrumbs(nav: StorageNav): { label: string; index: number }[] {
  return nav.stack.map((loc, index) => ({ label: locationLabel(loc), index }))
}

/** Back to crumb `index` (0 = the section). */
export function navTo(nav: StorageNav, index: number): StorageNav {
  return index >= 0 && index < nav.stack.length - 1 ? make(nav.stack.slice(0, index + 1)) : nav
}
