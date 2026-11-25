import { reactive } from 'vue'
// Where the Storage app is (#40): a section, or an object shown in its
// section. Each Storage panel keeps its own stack of locations.

export type StorageSection = 'volumes' | 'disks' | 'raid' | 'lvm' | 'mounts' | 'maintenance' | 'pools' | 'datasets' | 'zfs-import'
export type StorageLocation =
  | { kind: 'section'; section: StorageSection }
  | { kind: 'volume'; id: string }
  | { kind: 'create-volume'; disks?: string[] }
  | { kind: 'disk'; name: string }
  | { kind: 'array'; name: string }
  | { kind: 'vg'; name: string }
  | { kind: 'pool'; name: string }

// English names; i18n/labels.ts puts them in the interface language.
export const SECTION_LABELS = reactive<Record<StorageSection, string>>({
  'volumes': 'Volumes', 'disks': 'Disks', 'raid': 'Arrays', 'lvm': 'Volume groups', 'mounts': 'Mounts', 'maintenance': 'Maintenance',
  'pools': 'Pools', 'datasets': 'Datasets', 'zfs-import': 'Import',
})
export const NAV_TEXT = reactive({ createVolume: 'Create volume' })

export function sectionOf(loc: StorageLocation): StorageSection {
  switch (loc.kind) {
    case 'section': return loc.section
    case 'volume':  return 'volumes'
    case 'create-volume': return 'volumes'
    case 'disk':    return 'disks'
    case 'array':   return 'raid'
    case 'vg':      return 'lvm'
    case 'pool':    return 'pools'
  }
}

/** Resolved names of objects, keyed `kind:key` (a volume's name for its id). */
export type LocationNames = Record<string, string>

export function locationLabel(loc: StorageLocation, names: LocationNames = {}): string {
  if (loc.kind === 'section') return SECTION_LABELS[loc.section]
  if (loc.kind === 'create-volume') return NAV_TEXT.createVolume
  const key = loc.kind === 'volume' ? loc.id : loc.name
  return names[`${loc.kind}:${key}`] ?? key
}

export interface StorageNav { stack: StorageLocation[]; current: StorageLocation }

const same = (a: StorageLocation, b: StorageLocation) => JSON.stringify(a) === JSON.stringify(b)
const make = (stack: StorageLocation[]): StorageNav => ({ stack, current: stack[stack.length - 1]! })

export function createNav(initial: StorageLocation = { kind: 'section', section: 'volumes' }): StorageNav {
  return navOpen(make([{ kind: 'section', section: sectionOf(initial) }]), initial)
}

export function navOpen(nav: StorageNav, loc: StorageLocation): StorageNav {
  if (loc.kind === 'section') return make([loc])
  if (same(nav.current, loc)) return nav
  const base: StorageLocation = { kind: 'section', section: sectionOf(loc) }
  // Opening an object from another section starts from that section.
  let stack = sectionOf(nav.current) === base.section ? nav.stack : [base]
  // The wizard is a step, not a place to come back to: what it opens replaces it.
  if (stack.length > 1 && stack[stack.length - 1]!.kind === 'create-volume') stack = stack.slice(0, -1)
  return make([...stack, loc])
}

export function navCrumbs(nav: StorageNav, names: LocationNames = {}): { label: string; index: number }[] {
  return nav.stack.map((loc, index) => ({ label: locationLabel(loc, names), index }))
}

/** Back to crumb `index` (0 = the section). */
export function navTo(nav: StorageNav, index: number): StorageNav {
  return index >= 0 && index < nav.stack.length - 1 ? make(nav.stack.slice(0, index + 1)) : nav
}

/** Moving from `from` to `to` leaves the Create volume wizard. */
export function leavesWizard(from: StorageNav, to: StorageNav): boolean {
  return from.current.kind === 'create-volume' && to.current.kind !== 'create-volume'
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
// The Storage app is in tabs, one per engine plus the shared ones (Disks,
// Maintenance). Each tab keeps its own stack of locations.

export type StorageTab = 'disks' | 'lvm' | 'zfs' | 'maintenance'

export const TAB_SECTIONS: Record<StorageTab, StorageSection[]> = {
  disks: ['disks'],
  lvm: ['volumes', 'raid', 'lvm', 'mounts'],
  zfs: ['pools', 'datasets', 'zfs-import'],
  maintenance: ['maintenance'],
}

// English names; i18n/labels.ts puts them in the interface language.
export const TAB_LABELS = reactive<Record<StorageTab, string>>({
  disks: 'Disks', lvm: 'LVM', zfs: 'ZFS', maintenance: 'Maintenance',
})

export function tabOf(loc: StorageLocation): StorageTab {
  const section = sectionOf(loc)
  return (Object.keys(TAB_SECTIONS) as StorageTab[]).find(t => TAB_SECTIONS[t].includes(section))!
}

/** The tabs shown: ZFS only on a host that has it. */
export function visibleTabs(o: { zfs: boolean }): StorageTab[] {
  return o.zfs ? ['disks', 'lvm', 'zfs', 'maintenance'] : ['disks', 'lvm', 'maintenance']
}

/** The tab Storage opens on: Disks until a volume exists, then the engine
 *  holding most of them (`volumes` counts the LVM ones). */
export function defaultTab(o: { volumes: number; zfsVolumes?: number }): StorageTab {
  const zfs = o.zfsVolumes ?? 0
  if (o.volumes === 0 && zfs === 0) return 'disks'
  return zfs > o.volumes ? 'zfs' : 'lvm'
}

export interface TabbedNav { tab: StorageTab; navs: Partial<Record<StorageTab, StorageNav>> }

const firstOf = (tab: StorageTab): StorageNav => createNav({ kind: 'section', section: TAB_SECTIONS[tab][0]! })

export function createTabbedNav(tab: StorageTab): TabbedNav {
  return { tab, navs: { [tab]: firstOf(tab) } }
}

export function currentNav(t: TabbedNav): StorageNav {
  return t.navs[t.tab] ?? firstOf(t.tab)
}

/** Opens `loc` in its own tab, which becomes the current one. Within the
 *  current tab it goes on top of the stack; a link into another tab starts that
 *  tab from its section, as the breadcrumb leads there from the link. */
export function tabbedOpen(t: TabbedNav, loc: StorageLocation): TabbedNav {
  const tab = tabOf(loc)
  const base = tab === t.tab ? (t.navs[tab] ?? firstOf(tab)) : createNav({ kind: 'section', section: sectionOf(loc) })
  const nav = navOpen(base, loc)
  return { tab, navs: { ...t.navs, [tab]: nav } }
}

/** Shows `tab` where it was left; a tab never opened starts on its first section. */
export function switchTab(t: TabbedNav, tab: StorageTab): TabbedNav {
  return { tab, navs: { ...t.navs, [tab]: t.navs[tab] ?? firstOf(tab) } }
}

/** Replaces the current tab's stack (breadcrumbs). */
export function withNav(t: TabbedNav, nav: StorageNav): TabbedNav {
  return { tab: t.tab, navs: { ...t.navs, [t.tab]: nav } }
}
