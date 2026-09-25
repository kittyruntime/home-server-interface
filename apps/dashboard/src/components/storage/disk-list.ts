// Pure helpers behind the Devices list: one row per physical disk with its
// role, owners and health, plus the summary counts, filters, sort and grouping
// the list offers. No Vue or tRPC imports, so it can be unit tested with node.

export type DiskRole = 'system' | 'raid' | 'lvm' | 'mounted' | 'free' | 'unmounted'
export type DiskHealth = 'passed' | 'warning' | 'failed' | 'unknown'
export type DiskKind = 'NVMe' | 'SSD' | 'HDD' | 'USB' | ''

/** The fields of a block device (see store.ts BlockDev) the list relies on. */
export type ListDev = {
  name:        string
  size:        number
  type:        string
  fstype:      string
  mountpoint:  string
  model:       string
  serial?:     string
  wwn?:        string
  isSystem:    boolean
  isRemovable: boolean
  usage?:      string
  owner?:      string
  children?:   ListDev[]
}

/** What SMART says about a disk, reduced to what the list shows. */
export type DiskSmart = { health: DiskHealth; temperature?: number; rotationRate?: number; available?: boolean }

export type DiskRow<D extends ListDev = ListDev> = {
  disk:        D
  role:        DiskRole
  /** Assembled arrays (md0) using the disk or one of its partitions. */
  raidOwners:  string[]
  /** Volume groups using the disk, a partition, or an array built on it. */
  vgOwners:    string[]
  health:      DiskHealth
  temperature: number
  kind:        DiskKind
}

export const ROLE_LABELS: Record<DiskRole, string> = {
  system:    'System',
  raid:      'RAID member',
  lvm:       'LVM PV',
  mounted:   'Mounted',
  free:      'Free',
  unmounted: 'Not mounted',
}

// Order used when sorting or grouping by role.
const ROLE_ORDER: DiskRole[] = ['system', 'raid', 'lvm', 'mounted', 'unmounted', 'free']
const HEALTH_ORDER: DiskHealth[] = ['failed', 'warning', 'unknown', 'passed']

function memberKind(dev: ListDev): 'raid' | 'lvm' | null {
  // Workers older than the usage field: fall back to the on-disk signature.
  const usage = dev.usage
    ?? (dev.fstype === 'linux_raid_member' ? 'raid-member' : dev.fstype === 'LVM2_member' ? 'lvm-pv' : undefined)
  if (usage === 'raid-member') return 'raid'
  if (usage === 'lvm-pv') return 'lvm'
  return null
}

function walk(dev: ListDev, fn: (d: ListDev) => void) {
  fn(dev)
  dev.children?.forEach(c => walk(c, fn))
}

export function diskKind(disk: ListDev, smart?: DiskSmart): DiskKind {
  if (disk.name.startsWith('nvme')) return 'NVMe'
  if (disk.isRemovable) return 'USB'
  if (smart?.available && smart.rotationRate !== undefined) return smart.rotationRate === 0 ? 'SSD' : 'HDD'
  return ''
}

/** One row per physical disk. The role is the most significant thing the disk
 *  or anything on it is used for: system, then RAID, LVM, a mount. */
export function diskRow<D extends ListDev>(disk: D, smart?: DiskSmart): DiskRow<D> {
  const raidOwners = new Set<string>()
  const vgOwners   = new Set<string>()
  let raid = false, lvm = false, mounted = false
  walk(disk, d => {
    const kind = memberKind(d)
    if (kind === 'raid') { raid = true; if (d.owner) raidOwners.add(d.owner) }
    if (kind === 'lvm')  { lvm = true;  if (d.owner) vgOwners.add(d.owner) }
    if (d.mountpoint) mounted = true
  })
  const role: DiskRole =
    disk.isSystem ? 'system'
    : raid ? 'raid'
    : lvm ? 'lvm'
    : mounted ? 'mounted'
    : disk.usage === 'free' || (!disk.usage && !disk.fstype && !disk.children?.length) ? 'free'
    : 'unmounted'
  return {
    disk, role,
    raidOwners: [...raidOwners].sort(),
    vgOwners:   [...vgOwners].sort(),
    health:      smart?.health ?? 'unknown',
    temperature: smart?.temperature ?? 0,
    kind:        diskKind(disk, smart),
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

export type DiskSummary = {
  disks:         number
  totalBytes:    number
  freeBytes:     number
  roles:         Record<DiskRole, number>
  health:        Record<DiskHealth, number>
}

export function summarize(rows: DiskRow[]): DiskSummary {
  const roles  = { system: 0, raid: 0, lvm: 0, mounted: 0, free: 0, unmounted: 0 } as Record<DiskRole, number>
  const health = { passed: 0, warning: 0, failed: 0, unknown: 0 } as Record<DiskHealth, number>
  let totalBytes = 0, freeBytes = 0
  for (const r of rows) {
    roles[r.role]++
    health[r.health]++
    totalBytes += r.disk.size
    if (r.role === 'free') freeBytes += r.disk.size
  }
  return { disks: rows.length, totalBytes, freeBytes, roles, health }
}

// ── Filter ────────────────────────────────────────────────────────────────────

export type DiskFilter = {
  search?: string
  role?:   DiskRole | 'all'
  health?: DiskHealth | 'all'
}

/** Text a search matches against: kernel names (disk and partitions), model,
 *  serial, WWN and the arrays/VGs using the disk. */
function searchText(r: DiskRow): string {
  const parts: string[] = [r.disk.model, r.disk.serial ?? '', r.disk.wwn ?? '', ...r.raidOwners, ...r.vgOwners]
  walk(r.disk, d => parts.push(d.name, '/dev/' + d.name, d.mountpoint))
  return parts.join(' ').toLowerCase()
}

export function filterRows<R extends DiskRow>(rows: R[], f: DiskFilter): R[] {
  const terms = (f.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter(r => {
    if (f.role && f.role !== 'all' && r.role !== f.role) return false
    if (f.health && f.health !== 'all' && r.health !== f.health) return false
    if (terms.length) {
      const text = searchText(r)
      if (!terms.every(t => text.includes(t))) return false
    }
    return true
  })
}

// ── Sort ──────────────────────────────────────────────────────────────────────

export type SortKey = 'name' | 'model' | 'serial' | 'size' | 'kind' | 'role' | 'health' | 'temperature'
export type SortDir = 'asc' | 'desc'

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function compareBy(key: SortKey, a: DiskRow, b: DiskRow): number {
  switch (key) {
    case 'size':        return a.disk.size - b.disk.size
    case 'temperature': return a.temperature - b.temperature
    case 'role':        return ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
    case 'health':      return HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health)
    case 'model':       return natural.compare(a.disk.model, b.disk.model)
    case 'serial':      return natural.compare(a.disk.serial ?? '', b.disk.serial ?? '')
    case 'kind':        return natural.compare(a.kind, b.kind)
    case 'name':        return 0
  }
}

/** Sorts by `key`, then by kernel name (sda, sdb, …, sdaa) so ties are stable. */
export function sortRows<R extends DiskRow>(rows: R[], key: SortKey, dir: SortDir): R[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const byName = natural.compare(a.disk.name, b.disk.name)
    const c = compareBy(key, a, b)
    return c !== 0 ? sign * c : key === 'name' ? sign * byName : byName
  })
}

// ── Group ─────────────────────────────────────────────────────────────────────

export type DiskGroup<R extends DiskRow = DiskRow> = { key: string; label: string; rows: R[] }

/** Groups rows by what they are used for, so the members of one array or
 *  volume group appear together. Keeps the incoming order inside a group. */
export function groupRows<R extends DiskRow>(rows: R[]): DiskGroup<R>[] {
  const groups = new Map<string, DiskGroup<R>>()
  function add(key: string, label: string, row: R) {
    let g = groups.get(key)
    if (!g) { g = { key, label, rows: [] }; groups.set(key, g) }
    g.rows.push(row)
  }
  for (const r of rows) {
    if (r.role === 'raid') {
      const md = r.raidOwners[0]
      add(md ? `raid:${md}` : 'raid:', md ? `RAID ${md}` : 'RAID members (inactive)', r)
    } else if (r.role === 'lvm') {
      const vg = r.vgOwners[0]
      add(vg ? `lvm:${vg}` : 'lvm:', vg ? `Volume group ${vg}` : 'LVM members (no volume group)', r)
    } else {
      add(r.role, ROLE_LABELS[r.role], r)
    }
  }
  const rank = (k: string) => ROLE_ORDER.indexOf(k.split(':')[0] as DiskRole)
  return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || natural.compare(a.key, b.key))
}

/** Disks a new RAID array or volume group can take as a whole. */
export function isSelectable(r: DiskRow): boolean {
  return r.role === 'free' && !r.disk.isSystem && r.disk.type === 'disk'
}
