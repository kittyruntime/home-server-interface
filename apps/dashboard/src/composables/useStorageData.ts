// apps/dashboard/src/composables/useStorageData.ts
import { reactive, toRefs, onMounted } from 'vue'
import { trpc } from '../lib/trpc'

// ── Types ─────────────────────────────────────────────────────────────────────

export type BlockDev = {
  name:        string
  path:        string
  size:        number
  type:        string
  fstype:      string
  mountpoint:  string
  model:       string
  uuid:        string
  isSystem:    boolean
  isRemovable: boolean
  usageTotal:  number
  usageUsed:   number
  usageFree:   number
  children:    BlockDev[]
}

export type RaidArray = {
  name:    string
  level:   string
  state:   string
  devices: string[]
  active:  number
  total:   number
}

export type LvmPV = { name: string; vgName: string; size: number; free: number }
export type LvmVG = { name: string; size: number; free: number; pvCount: number; lvCount: number }
export type LvmLV = { name: string; vgName: string; size: number; path: string }

// ── Shared helpers ─────────────────────────────────────────────────────────────

export const criticalMountPoints: Record<string, boolean> = {
  '/': true, '/boot': true, '/boot/efi': true, '/boot/grub': true,
  '/usr': true, '/var': true, '/home': true, '/etc': true,
}

export function fmtBytes(n: number): string {
  if (!n || n <= 0)   return '—'
  if (n < 1024)       return `${n} B`
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3)  return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n < 1024 ** 4)  return `${(n / 1024 ** 3).toFixed(2)} GB`
  return `${(n / 1024 ** 4).toFixed(2)} TB`
}

export function usagePct(dev: BlockDev | { total: number; used: number }): number {
  const total = 'usageTotal' in dev ? (dev as BlockDev).usageTotal : (dev as { total: number }).total
  const used  = 'usageUsed'  in dev ? (dev as BlockDev).usageUsed  : (dev as { used: number }).used
  return total > 0 ? Math.min(100, (used / total) * 100) : 0
}

export function usageBarClass(pct: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 75) return 'bg-yellow-500'
  return 'bg-[var(--c-accent)]'
}

export function fmtHours(h: number): string {
  if (h < 24) return `${h} h`
  if (h < 24 * 365) return `${Math.round(h / 24)} days`
  const y = Math.floor(h / (24 * 365))
  const d = Math.round((h % (24 * 365)) / 24)
  return `${y} yr ${d} d`
}

export function fmtTiB(v: number): string {
  if (v < 1) return `${(v * 1024).toFixed(0)} GiB`
  return `${v.toFixed(1)} TiB`
}

export function raidLevelLabel(level: string): string {
  const m: Record<string, string> = {
    raid0: 'RAID 0', raid1: 'RAID 1', raid5: 'RAID 5',
    raid6: 'RAID 6', raid10: 'RAID 10', linear: 'Linear',
  }
  return m[level] ?? level.toUpperCase()
}

export function raidDescription(level: string): string {
  const m: Record<string, string> = {
    raid0:  'Striping — no redundancy, max throughput',
    raid1:  'Mirroring — 1 drive fault tolerance',
    raid5:  'Parity striping — 1 drive fault tolerance',
    raid6:  'Double parity — 2 drive fault tolerance',
    raid10: 'Mirror + stripe — high performance & redundancy',
    linear: 'Linear concatenation',
  }
  return m[level] ?? ''
}

export function isRaidHealthy(r: RaidArray): boolean {
  return (r.state === 'active' || r.state === 'clean') && r.active === r.total
}

export function lvToDmName(lv: LvmLV): string {
  return lv.path
    .replace('/dev/', '')
    .split('/')
    .map((p: string) => p.replace(/-/g, '--'))
    .join('-')
}

export function lvToBlockDev(lv: LvmLV, devices: BlockDev[]): BlockDev {
  const dmName = lvToDmName(lv)
  const allDevs: BlockDev[] = []
  function walk(d: BlockDev) { allDevs.push(d); d.children?.forEach(walk) }
  devices.forEach(walk)
  const mountInfo = allDevs.find(d => d.name === dmName)
  const mp = mountInfo?.mountpoint ?? ''
  const isSystemLv = mountInfo?.isSystem === true || (mp !== '' && mp in criticalMountPoints)
  return {
    name:        dmName,
    path:        lv.path,
    size:        lv.size,
    type:        'lvm',
    fstype:      mountInfo?.fstype ?? '',
    mountpoint:  mp,
    model:       '',
    uuid:        mountInfo?.uuid ?? '',
    isSystem:    isSystemLv,
    isRemovable: false,
    usageTotal:  mountInfo?.usageTotal ?? 0,
    usageUsed:   mountInfo?.usageUsed ?? 0,
    usageFree:   mountInfo?.usageFree ?? 0,
    children:    [],
  }
}

// ── Singleton reactive state ───────────────────────────────────────────────────

const state = reactive({
  loading: false,
  error:   '',
  devices: [] as BlockDev[],
  raids:   [] as RaidArray[],
  lvmPVs:  [] as LvmPV[],
  lvmVGs:  [] as LvmVG[],
  lvmLVs:  [] as LvmLV[],
  loaded:  false,
})

let inflight: Promise<void> | null = null

async function fetchAll(): Promise<void> {
  state.loading = true
  state.error   = ''
  try {
    const [blk, lvm] = await Promise.all([
      trpc.system.blockDevices.query() as Promise<{ devices: BlockDev[]; raids: RaidArray[] }>,
      trpc.system.lvmInfo.query().catch(() => ({ pvs: [], vgs: [], lvs: [] })),
    ])
    state.devices = blk.devices ?? []
    state.raids   = blk.raids   ?? []
    state.lvmPVs  = lvm.pvs ?? []
    state.lvmVGs  = lvm.vgs ?? []
    state.lvmLVs  = lvm.lvs ?? []
    state.loaded  = true
  } catch (e: unknown) {
    state.error = (e as { message?: string })?.message ?? 'Failed to load storage info'
  } finally {
    state.loading = false
    inflight = null
  }
}

export function useStorageData() {
  function refresh(): Promise<void> {
    if (!inflight) inflight = fetchAll()
    return inflight
  }
  onMounted(() => { refresh() })
  return { ...toRefs(state), refresh }
}
