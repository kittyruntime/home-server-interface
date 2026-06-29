<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import LoadingSpinner from './ui/LoadingSpinner.vue'

// ── Types ─────────────────────────────────────────────────────────────────────

type BlockDev = {
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

type RaidArray = {
  name:    string
  level:   string
  state:   string
  devices: string[]
  active:  number
  total:   number
}

// ── Types (LVM) ───────────────────────────────────────────────────────────────

type LvmPV = { name: string; vgName: string; size: number; free: number }
type LvmVG = { name: string; size: number; free: number; pvCount: number; lvCount: number }
type LvmLV = { name: string; vgName: string; size: number; path: string }

// ── State ─────────────────────────────────────────────────────────────────────

const loading = ref(true)
const error   = ref('')
const devices = ref<BlockDev[]>([])
const raids   = ref<RaidArray[]>([])
const lvmPVs  = ref<LvmPV[]>([])
const lvmVGs  = ref<LvmVG[]>([])
const lvmLVs  = ref<LvmLV[]>([])

// Tab selection
const activeTab = ref<'disks' | 'raid' | 'lvm'>('disks')

const physicalDisks = computed(() =>
  devices.value.filter(d => d.type === 'disk')
)

const raidBlockDevs = computed(() =>
  devices.value.filter(d => d.type === 'md' || raids.value.find(r => r.name === d.name))
)

// lsblk reports RAID devices as type "raid0", "raid1", "raid5", "raid10" — not "md".
// A device or any of its descendants is "committed to RAID" if its name is a known
// RAID member or array name. We check recursively so parent disks of RAID-member
// partitions are also excluded.
function makeRaidChecker(inRaid: Set<string>, mdNames: Set<string>) {
  function committedToRaid(dev: BlockDev): boolean {
    if (inRaid.has(dev.name) || mdNames.has(dev.name)) return true
    return (dev.children ?? []).some(committedToRaid)
  }
  return committedToRaid
}

// Walk the full device tree and return a flat list of all devices.
function allDevices(): BlockDev[] {
  const out: BlockDev[] = []
  function walk(d: BlockDev) { out.push(d); d.children?.forEach(walk) }
  devices.value.forEach(walk)
  return out
}

// Eligible for RAID creation: free disks/partitions with no RAID commitment anywhere in their subtree
const eligibleForRaid = computed<BlockDev[]>(() => {
  const inRaid  = new Set(raids.value.flatMap(r => r.devices))
  const mdNames = new Set(raids.value.map(r => r.name))
  const pvDevs  = new Set(lvmPVs.value.map(p => p.name.replace('/dev/', '')))
  const committed = makeRaidChecker(inRaid, mdNames)
  const out: BlockDev[] = []
  function collect(dev: BlockDev) {
    if (committed(dev)) return  // skip device AND its subtree
    if (!dev.isSystem && !dev.mountpoint && !pvDevs.has(dev.name) &&
        dev.type !== 'rom' && dev.type !== 'loop' && dev.type !== 'lvm') {
      out.push(dev)
    }
    dev.children?.forEach(collect)
  }
  devices.value.forEach(collect)
  return out
})

// Eligible for LVM PV: free disks/partitions (not RAID-committed) + assembled RAID arrays (once each)
const eligibleForLvm = computed<BlockDev[]>(() => {
  const inRaid  = new Set(raids.value.flatMap(r => r.devices))
  const mdNames = new Set(raids.value.map(r => r.name))
  const pvDevs  = new Set(lvmPVs.value.map(p => p.name.replace('/dev/', '')))
  const committed = makeRaidChecker(inRaid, mdNames)
  const out: BlockDev[] = []
  function collect(dev: BlockDev) {
    if (committed(dev)) return  // skip RAID-committed devices and their subtrees
    if (!dev.isSystem && !dev.mountpoint && !pvDevs.has(dev.name) &&
        dev.type !== 'rom' && dev.type !== 'loop' && dev.type !== 'lvm') {
      out.push(dev)
    }
    dev.children?.forEach(collect)
  }
  devices.value.forEach(collect)
  // Add each assembled RAID array exactly once as a PV candidate
  const flat = allDevices()
  const seen = new Set<string>()
  for (const r of raids.value) {
    if (seen.has(r.name)) continue
    seen.add(r.name)
    const md = flat.find(d => d.name === r.name)
    if (md && !md.mountpoint && !md.isSystem && !pvDevs.has(md.name)) out.push(md)
  }
  return out
})

// Convert lv.path (/dev/ubuntu-vg/ubuntu-lv) to the kernel dm-mapper device name
// LVM doubles hyphens in VG/LV names: ubuntu-vg → ubuntu--vg
function lvToDmName(lv: LvmLV): string {
  return lv.path
    .replace('/dev/', '')
    .split('/')
    .map((p: string) => p.replace(/-/g, '--'))
    .join('-')
}

// LV as a pseudo-BlockDev so Format/Mount/Unmount reuse existing dialogs
function lvToBlockDev(lv: LvmLV): BlockDev {
  const dmName = lvToDmName(lv)
  // Walk full device tree (including children) to find the dm device
  const allDevs: BlockDev[] = []
  function walk(d: BlockDev) { allDevs.push(d); d.children?.forEach(walk) }
  devices.value.forEach(walk)
  const mountInfo = allDevs.find(d => d.name === dmName)
  const mp = mountInfo?.mountpoint ?? ''
  const isSystemLv = mountInfo?.isSystem === true || (mp !== '' && mp in criticalMountPoints)
  return {
    name:        dmName,     // ubuntu--vg-ubuntu--lv (shown in format confirm)
    path:        lv.path,    // /dev/ubuntu-vg/ubuntu-lv — the valid symlink used for ops
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

// VG free space as percentage
function vgFreePct(vg: LvmVG): number {
  return vg.size > 0 ? Math.min(100, (vg.free / vg.size) * 100) : 0
}

// ── LVM wizard ────────────────────────────────────────────────────────────────

const lvmWiz = ref<{
  step:      1 | 2 | 3
  pvDevs:    string[]   // selected device names for PV creation
  vgName:    string
  lvName:    string
  lvSizeGB:  number     // 0 = all free
  busy:      boolean
  err:       string
} | null>(null)

function openLvmWizard() {
  lvmWiz.value = { step: 1, pvDevs: [], vgName: '', lvName: 'lv0', lvSizeGB: 0, busy: false, err: '' }
}

function toggleLvmDev(name: string) {
  if (!lvmWiz.value) return
  const i = lvmWiz.value.pvDevs.indexOf(name)
  if (i >= 0) lvmWiz.value.pvDevs.splice(i, 1)
  else lvmWiz.value.pvDevs.push(name)
}

async function doCreateLvm() {
  if (!lvmWiz.value) return
  const w = lvmWiz.value
  w.busy = true; w.err = ''
  try {
    // 1. pvcreate on selected devices
    await trpc.system.createPv.mutate({ devices: w.pvDevs })
    // 2. vgcreate
    await trpc.system.createVg.mutate({ name: w.vgName, devices: w.pvDevs })
    // 3. lvcreate
    const sizeBytes = w.lvSizeGB > 0 ? Math.floor(w.lvSizeGB * 1024 ** 3) : 0
    await trpc.system.createLv.mutate({ vgName: w.vgName, lvName: w.lvName, sizeBytes })
    lvmWiz.value = null
    await load()
  } catch (e: any) {
    w.err = e?.message ?? 'LVM creation failed'
  } finally {
    if (lvmWiz.value) w.busy = false
  }
}

// Add LV to existing VG
const addLvDlg = ref<{
  vg:       LvmVG
  lvName:   string
  lvSizeGB: number
  busy:     boolean
  err:      string
} | null>(null)

async function doAddLv() {
  if (!addLvDlg.value) return
  const d = addLvDlg.value
  d.busy = true; d.err = ''
  try {
    const sizeBytes = d.lvSizeGB > 0 ? Math.floor(d.lvSizeGB * 1024 ** 3) : 0
    await trpc.system.createLv.mutate({ vgName: d.vg.name, lvName: d.lvName, sizeBytes })
    addLvDlg.value = null
    await load()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to create LV'
  } finally {
    if (addLvDlg.value) d.busy = false
  }
}

// Remove LV confirmation
const removeLvDlg = ref<{ lv: LvmLV; confirm: string; busy: boolean; err: string } | null>(null)

async function doRemoveLv() {
  if (!removeLvDlg.value || removeLvDlg.value.confirm !== removeLvDlg.value.lv.name) return
  const d = removeLvDlg.value
  d.busy = true; d.err = ''
  try {
    await trpc.system.removeLv.mutate({ vgName: d.lv.vgName, lvName: d.lv.name })
    removeLvDlg.value = null
    await load()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to remove LV'
  } finally {
    if (removeLvDlg.value) d.busy = false
  }
}

// Remove VG confirmation
const removeVgDlg = ref<{ vg: LvmVG; confirm: string; busy: boolean; err: string } | null>(null)

async function doRemoveVg() {
  if (!removeVgDlg.value || removeVgDlg.value.confirm !== removeVgDlg.value.vg.name) return
  const d = removeVgDlg.value
  d.busy = true; d.err = ''
  try {
    await trpc.system.removeVg.mutate({ vgName: d.vg.name })
    removeVgDlg.value = null
    await load()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to remove VG'
  } finally {
    if (removeVgDlg.value) d.busy = false
  }
}

// ── Partition dialogs ─────────────────────────────────────────────────────────

const partInitDlg = ref<{ disk: BlockDev; confirm: string; busy: boolean; err: string } | null>(null)

async function doPartInit() {
  if (!partInitDlg.value || partInitDlg.value.confirm !== partInitDlg.value.disk.name) return
  const d = partInitDlg.value
  d.busy = true; d.err = ''
  try {
    await trpc.system.initPartitionTable.mutate({ device: d.disk.name })
    partInitDlg.value = null
    await load()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to initialise partition table'
  } finally {
    if (partInitDlg.value) d.busy = false
  }
}

const partCreateDlg = ref<{ disk: BlockDev; busy: boolean; err: string } | null>(null)

async function doPartCreate() {
  if (!partCreateDlg.value) return
  const d = partCreateDlg.value
  d.busy = true; d.err = ''
  try {
    await trpc.system.createPartition.mutate({ device: d.disk.name, startPct: 0, endPct: 100 })
    partCreateDlg.value = null
    await load()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to create partition'
  } finally {
    if (partCreateDlg.value) d.busy = false
  }
}

const partDeleteDlg = ref<{ disk: BlockDev; part: BlockDev; busy: boolean; err: string } | null>(null)

function partNumOf(diskName: string, partName: string): string {
  // sda1 → 1, nvme0n1p2 → 2
  const suffix = partName.replace(diskName, '')
  return suffix.replace(/^p/, '')
}

async function doPartDelete() {
  if (!partDeleteDlg.value) return
  const d = partDeleteDlg.value
  const num = partNumOf(d.disk.name, d.part.name)
  d.busy = true; d.err = ''
  try {
    await trpc.system.deletePartition.mutate({ device: d.disk.name, partNum: num })
    partDeleteDlg.value = null
    await load()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to delete partition'
  } finally {
    if (partDeleteDlg.value) d.busy = false
  }
}

// ── UI state: dropdown menus + expandable danger zones ────────────────────────

const openMenu    = ref<string | null>(null)
const dangerDisks = ref(new Set<string>())

function toggleDanger(name: string) {
  const s = new Set(dangerDisks.value)
  if (s.has(name)) s.delete(name)
  else s.add(name)
  dangerDisks.value = s
}

// Whether a VG is system-owned (has an LV mounted at a critical path)
function isSystemVg(vgName: string): boolean {
  return lvmLVs.value
    .filter(l => l.vgName === vgName)
    .some(l => {
      const bd = lvToBlockDev(l)
      return bd.isSystem || Object.keys(criticalMountPoints).some(mp => bd.mountpoint === mp)
    })
}

const criticalMountPoints = {
  '/': true, '/boot': true, '/boot/efi': true, '/boot/grub': true,
  '/usr': true, '/var': true, '/home': true, '/etc': true,
}

async function load() {
  loading.value = true
  error.value   = ''
  try {
    const [blk, lvm] = await Promise.all([
      trpc.system.blockDevices.query() as Promise<{ devices: BlockDev[]; raids: RaidArray[] }>,
      trpc.system.lvmInfo.query().catch(() => ({ pvs: [], vgs: [], lvs: [] })),
    ])
    devices.value = blk.devices ?? []
    raids.value   = blk.raids   ?? []
    lvmPVs.value  = lvm.pvs ?? []
    lvmVGs.value  = lvm.vgs ?? []
    lvmLVs.value  = lvm.lvs ?? []
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load storage info'
  } finally {
    loading.value = false
  }
}

onMounted(load)

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (!n || n <= 0)   return '—'
  if (n < 1024)       return `${n} B`
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3)  return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n < 1024 ** 4)  return `${(n / 1024 ** 3).toFixed(2)} GB`
  return `${(n / 1024 ** 4).toFixed(2)} TB`
}

function usagePct(dev: BlockDev | { total: number; used: number }): number {
  const total = 'usageTotal' in dev ? dev.usageTotal : dev.total
  const used  = 'usageUsed'  in dev ? dev.usageUsed  : dev.used
  return total > 0 ? Math.min(100, (used / total) * 100) : 0
}

function usageBarClass(pct: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 75) return 'bg-yellow-500'
  return 'bg-[var(--c-accent)]'
}

function raidLevelLabel(level: string): string {
  const m: Record<string, string> = {
    raid0: 'RAID 0', raid1: 'RAID 1', raid5: 'RAID 5',
    raid6: 'RAID 6', raid10: 'RAID 10', linear: 'Linear',
  }
  return m[level] ?? level.toUpperCase()
}

function raidDescription(level: string): string {
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

function isRaidHealthy(r: RaidArray): boolean {
  return (r.state === 'active' || r.state === 'clean') && r.active === r.total
}

function raidBlockDev(name: string): BlockDev | undefined {
  return raidBlockDevs.value.find(d => d.name === name)
}

// ── Format wizard ─────────────────────────────────────────────────────────────

type FsType = 'ext4' | 'xfs' | 'btrfs' | 'fat32'

const FS_OPTIONS: { id: FsType; name: string; tag: string; desc: string }[] = [
  { id: 'ext4',  name: 'ext4',  tag: 'Recommended', desc: 'Stable, journaled filesystem. Widely supported on Linux. Best for general use and NAS data.' },
  { id: 'xfs',   name: 'XFS',   tag: 'Large files',  desc: 'High-performance filesystem. Excellent for large media files and backups. Cannot be shrunk once created.' },
  { id: 'btrfs', name: 'Btrfs', tag: 'Advanced',    desc: 'Modern copy-on-write filesystem with built-in checksums and snapshot support. More complex to manage.' },
  { id: 'fat32', name: 'FAT32', tag: 'Cross-platform', desc: 'Compatible with Windows and macOS without drivers. No file permissions, 4 GB file size limit. For USB/external drives only.' },
]

const formatWiz = ref<{
  dev:     BlockDev
  step:    1 | 2 | 3
  fstype:  FsType
  label:   string
  confirm: string
  busy:    boolean
  err:     string
} | null>(null)

function openFormat(dev: BlockDev) {
  formatWiz.value = { dev, step: 1, fstype: 'ext4', label: '', confirm: '', busy: false, err: '' }
}

async function doFormat() {
  if (!formatWiz.value) return
  const w = formatWiz.value
  if (w.confirm !== w.dev.name) return
  w.busy = true
  w.err  = ''
  try {
    // Use path-relative device (/dev/vg/lv → vg/lv) so LVM symlinks resolve correctly
    const device = w.dev.path.replace(/^\/dev\//, '')
    await trpc.system.formatDisk.mutate({ device, fstype: w.fstype, label: w.label || undefined })
    formatWiz.value = null
    await load()
  } catch (e: any) {
    w.err = e?.message ?? 'Format failed'
  } finally {
    if (formatWiz.value) w.busy = false
  }
}

// ── Mount dialog ──────────────────────────────────────────────────────────────

const mountDlg = ref<{
  dev:     BlockDev
  mp:      string
  options: string
  persist: boolean
  busy:    boolean
  err:     string
} | null>(null)

function openMount(dev: BlockDev) {
  mountDlg.value = { dev, mp: `/mnt/${dev.name}`, options: 'defaults', persist: true, busy: false, err: '' }
}

async function doMount() {
  if (!mountDlg.value) return
  const d = mountDlg.value
  d.busy = true
  d.err  = ''
  try {
    const device = d.dev.path.replace(/^\/dev\//, '')
    await trpc.system.mountDevice.mutate({ device, mountpoint: d.mp, options: d.options || undefined, persist: d.persist })
    mountDlg.value = null
    await load()
  } catch (e: any) {
    d.err = e?.message ?? 'Mount failed'
  } finally {
    if (mountDlg.value) d.busy = false
  }
}

// ── Unmount dialog ────────────────────────────────────────────────────────────

const umountDlg = ref<{
  dev:     BlockDev
  rmFstab: boolean
  busy:    boolean
  err:     string
} | null>(null)

function openUmount(dev: BlockDev) {
  umountDlg.value = { dev, rmFstab: false, busy: false, err: '' }
}

async function doUmount() {
  if (!umountDlg.value) return
  const d = umountDlg.value
  d.busy = true
  d.err  = ''
  try {
    await trpc.system.umountDevice.mutate({ mountpoint: d.dev.mountpoint, removeFromFstab: d.rmFstab })
    umountDlg.value = null
    await load()
  } catch (e: any) {
    d.err = e?.message ?? 'Unmount failed'
  } finally {
    if (umountDlg.value) d.busy = false
  }
}

// ── Create RAID wizard ────────────────────────────────────────────────────────

const RAID_LEVELS = [
  {
    level: 0, name: 'RAID 0', sub: 'Striping', minDev: 2,
    redundancy: 'None',
    desc: 'All drives are combined into one large volume. Maximum capacity and speed.',
    danger: 'No redundancy — if ANY single drive fails, ALL data on the array is lost permanently.',
    capacityHint: 'Capacity = total of all drives',
  },
  {
    level: 1, name: 'RAID 1', sub: 'Mirroring', minDev: 2,
    redundancy: '1 drive',
    desc: 'Data is written identically to every drive. Very safe, reads can be distributed.',
    danger: 'Usable space equals the size of ONE drive, regardless of how many drives you add.',
    capacityHint: 'Capacity = size of smallest drive',
  },
  {
    level: 5, name: 'RAID 5', sub: 'Parity', minDev: 3,
    redundancy: '1 drive',
    desc: 'Parity information is distributed across all drives. Good balance of capacity and safety.',
    danger: 'Requires at least 3 drives. Rebuilding after a drive failure is slow and stresses surviving drives.',
    capacityHint: 'Capacity = (N − 1) × drive size',
  },
  {
    level: 10, name: 'RAID 10', sub: 'Mirror + Stripe', minDev: 4,
    redundancy: '1 per mirror pair',
    desc: 'Pairs of mirrored drives, then striped together. Best performance and redundancy.',
    danger: 'Requires minimum 4 drives (even number). Uses 50% of total drive capacity.',
    capacityHint: 'Capacity = 50% of total drives',
  },
]

function nextMdName(): string {
  const used = new Set(raids.value.map(r => r.name))
  for (let i = 0; i < 10; i++) {
    if (!used.has(`md${i}`)) return `md${i}`
  }
  return 'md0'
}

const raidWiz = ref<{
  step:    1 | 2 | 3
  level:   number
  devs:    string[]
  name:    string
  confirm: string
  busy:    boolean
  err:     string
} | null>(null)

function openRaidWizard() {
  raidWiz.value = { step: 1, level: 1, devs: [], name: nextMdName(), confirm: '', busy: false, err: '' }
}

const selectedRaidLevel = computed(() =>
  RAID_LEVELS.find(l => l.level === raidWiz.value?.level) ?? RAID_LEVELS[1]!
)

function toggleRaidDev(name: string) {
  if (!raidWiz.value) return
  const idx = raidWiz.value.devs.indexOf(name)
  if (idx >= 0) raidWiz.value.devs.splice(idx, 1)
  else raidWiz.value.devs.push(name)
}

const raidCanAdvance = computed(() =>
  !!raidWiz.value && raidWiz.value.devs.length >= selectedRaidLevel.value.minDev
)

async function doCreateRaid() {
  if (!raidWiz.value) return
  const w = raidWiz.value
  if (w.confirm !== 'CREATE RAID') return
  w.busy = true
  w.err  = ''
  try {
    await trpc.system.createRaid.mutate({ name: w.name, level: w.level, devices: w.devs })
    raidWiz.value = null
    await load()
  } catch (e: any) {
    w.err = e?.message ?? 'RAID creation failed'
  } finally {
    if (raidWiz.value) w.busy = false
  }
}

// ── Destroy RAID ──────────────────────────────────────────────────────────────

const destroyDlg = ref<{
  raid:    RaidArray
  confirm: string
  busy:    boolean
  err:     string
} | null>(null)

function openDestroy(raid: RaidArray) {
  destroyDlg.value = { raid, confirm: '', busy: false, err: '' }
}

async function doDestroyRaid() {
  if (!destroyDlg.value) return
  const d = destroyDlg.value
  if (d.confirm !== d.raid.name) return
  d.busy = true
  d.err  = ''
  try {
    await trpc.system.stopRaid.mutate({ name: d.raid.name })
    destroyDlg.value = null
    await load()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to destroy RAID'
  } finally {
    if (destroyDlg.value) d.busy = false
  }
}
</script>

<template>
  <div>

    <!-- ── Header ──────────────────────────────────────────────────────────── -->
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Storage &amp; Disks</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Manage physical drives, RAID arrays, and LVM volumes.</p>
      </div>
      <button @click="load" :disabled="loading" title="Refresh"
        class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
        <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
    </div>

    <!-- Tab bar -->
    <div class="flex border-b border-[var(--c-border)] mb-5">
      <button v-for="t in ([
        { id: 'disks', label: 'Disks',        count: physicalDisks.length },
        { id: 'raid',  label: 'RAID',          count: raids.length },
        { id: 'lvm',   label: 'LVM',           count: lvmVGs.length },
      ] as const)" :key="t.id"
        @click="activeTab = t.id"
        :class="['flex items-center gap-1.5 px-3 pb-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
          activeTab === t.id
            ? 'border-[var(--c-accent)] text-[var(--c-accent)]'
            : 'border-transparent text-[var(--c-text-3)] hover:text-[var(--c-text-2)]']">
        {{ t.label }}
        <span v-if="t.count > 0" class="text-[10px] px-1.5 py-0.5 rounded-full tabular-nums"
          :class="activeTab === t.id ? 'bg-[var(--c-accent)]/15 text-[var(--c-accent)]' : 'bg-[var(--c-surface-deep)] text-[var(--c-text-3)]'">
          {{ t.count }}
        </span>
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6">
      <LoadingSpinner /> Loading…
    </div>

    <!-- Error -->
    <div v-else-if="error" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">
      {{ error }}
    </div>

    <!-- backdrop to close ⋯ menus -->
    <div v-if="openMenu" class="fixed inset-0 z-20" @click="openMenu = null"/>

    <template v-if="!loading && !error">

      <!-- ══════════════════════════════════════════════════════════════════════ -->
      <!-- TAB: RAID                                                              -->
      <!-- ══════════════════════════════════════════════════════════════════════ -->
      <section v-if="activeTab === 'raid'">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span v-if="raids.length" class="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--c-surface-deep)] text-[var(--c-text-3)] tabular-nums">{{ raids.length }} array{{ raids.length !== 1 ? 's' : '' }}</span>
          </div>
          <button @click="openRaidWizard"
            class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            Create RAID
          </button>
        </div>

        <div v-if="raids.length === 0" class="rounded-xl border border-dashed border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-6 text-center text-sm text-[var(--c-text-3)]">
          No RAID arrays configured. Create one to combine multiple drives for redundancy or performance.
        </div>

        <div v-else class="space-y-3">
          <div v-for="r in raids" :key="r.name"
            class="rounded-xl border bg-[var(--c-surface)] overflow-hidden flex"
            :class="isRaidHealthy(r) ? 'border-[var(--c-border)]' : 'border-red-500/20'">
            <!-- Left accent stripe -->
            <div class="w-0.5 shrink-0" :class="isRaidHealthy(r) ? 'bg-[var(--c-accent)]/50' : 'bg-red-500'"/>
            <div class="flex-1 min-w-0">
              <!-- Header -->
              <div class="flex items-center gap-3 px-4 pt-3.5 pb-2">
                <span class="text-[11px] font-bold px-2 py-0.5 rounded tracking-wide shrink-0"
                  :class="isRaidHealthy(r) ? 'bg-[var(--c-accent)]/10 text-[var(--c-accent)]' : 'bg-red-500/10 text-red-400'">
                  {{ raidLevelLabel(r.level) }}
                </span>
                <span class="font-mono text-sm text-[var(--c-text-1)]">/dev/{{ r.name }}</span>
                <div class="ml-auto flex items-center gap-3 shrink-0">
                  <span class="text-[11px] text-[var(--c-text-3)]">{{ r.active }}/{{ r.total }} drives</span>
                  <span class="inline-flex items-center gap-1.5 text-[11px] font-medium" :class="isRaidHealthy(r) ? 'text-green-400' : 'text-red-400'">
                    <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="isRaidHealthy(r) ? 'bg-green-400' : 'bg-red-400 animate-pulse'"/>
                    {{ isRaidHealthy(r) ? 'Healthy' : r.state }}
                  </span>
                  <!-- ⋯ menu -->
                  <div class="relative z-30">
                    <button @click.stop="openMenu = openMenu === r.name ? null : r.name"
                      :class="['w-7 h-7 flex items-center justify-center rounded-lg transition-colors', openMenu === r.name ? 'bg-[var(--c-hover)] text-[var(--c-text-1)]' : 'text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)]']">
                      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
                      </svg>
                    </button>
                    <div v-if="openMenu === r.name"
                      class="absolute right-0 top-full mt-1.5 bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl shadow-2xl overflow-hidden min-w-[176px]">
                      <div class="px-3 pt-2.5 pb-1.5 border-b border-[var(--c-border)]">
                        <p class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Danger zone</p>
                      </div>
                      <button @click="openDestroy(r); openMenu = null"
                        class="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors text-left">
                        <svg class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                          <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/>
                        </svg>
                        Destroy array…
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <p v-if="raidDescription(r.level)" class="text-[11px] text-[var(--c-text-3)] px-4 pb-3">{{ raidDescription(r.level) }}</p>

              <!-- Drive bay -->
              <div class="px-4 pb-4">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <template v-for="(dev, idx) in r.devices" :key="dev">
                    <div class="flex flex-col items-center gap-1.5">
                      <div class="relative rounded-lg border transition-colors"
                        :class="idx < r.active ? 'border-[var(--c-border-strong)] bg-[var(--c-surface-deep)]' : 'border-red-500/40 bg-red-500/5'">
                        <svg viewBox="0 0 52 68" class="w-12 h-16">
                          <rect x="3" y="3" width="46" height="62" rx="5"
                            :fill="idx < r.active ? 'var(--c-surface-deep)' : 'rgba(239,68,68,0.06)'"
                            :stroke="idx < r.active ? 'var(--c-border-strong)' : 'rgba(239,68,68,0.5)'" stroke-width="1.5"/>
                          <circle cx="9" cy="10" r="2" fill="var(--c-surface)" opacity="0.8"/>
                          <circle cx="43" cy="10" r="2" fill="var(--c-surface)" opacity="0.8"/>
                          <circle cx="9" cy="58" r="2" fill="var(--c-surface)" opacity="0.8"/>
                          <circle cx="43" cy="58" r="2" fill="var(--c-surface)" opacity="0.8"/>
                          <circle cx="26" cy="32" r="12" fill="none" :stroke="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.5)'" stroke-width="1" opacity="0.35"/>
                          <circle cx="26" cy="32" r="6" fill="none" :stroke="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.5)'" stroke-width="1" opacity="0.35"/>
                          <line x1="26" y1="32" x2="35" y2="21" :stroke="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.6)'" stroke-width="1.5" opacity="0.5" stroke-linecap="round"/>
                          <circle cx="26" cy="32" r="2.5" :fill="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.7)'" opacity="0.8"/>
                          <circle cx="40" cy="50" r="2" :fill="idx < r.active ? '#4ade80' : '#ef4444'" opacity="0.9"/>
                          <rect x="15" y="60" width="22" height="2.5" rx="1" fill="var(--c-text-3)" opacity="0.25"/>
                        </svg>
                      </div>
                      <span class="text-[10px] font-mono" :class="idx < r.active ? 'text-[var(--c-text-3)]' : 'text-red-400'">/dev/{{ dev }}</span>
                    </div>
                    <svg v-if="idx < r.devices.length - 1" class="w-3.5 h-3.5 text-[var(--c-text-3)] self-center mb-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                    </svg>
                  </template>
                  <div class="flex items-center self-center mb-5 gap-2 ml-1">
                    <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                    </svg>
                    <div>
                      <div class="text-[11px] font-semibold text-[var(--c-text-2)]">{{ raidLevelLabel(r.level) }}</div>
                      <div class="text-[10px] text-[var(--c-text-3)] font-mono">{{ raidBlockDev(r.name)?.mountpoint || 'not mounted' }}</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Usage & mount actions -->
              <template v-if="raidBlockDev(r.name)">
                <div class="border-t border-[var(--c-border)] px-4 py-3 flex items-center gap-3">
                  <div class="flex-1 min-w-0">
                    <div v-if="raidBlockDev(r.name)!.mountpoint">
                      <div class="flex justify-between items-baseline mb-1.5">
                        <span class="text-[11px] font-mono text-[var(--c-text-3)]">{{ raidBlockDev(r.name)!.mountpoint }}</span>
                        <span class="text-[11px] text-[var(--c-text-3)]">{{ fmtBytes(raidBlockDev(r.name)!.usageUsed) }} / {{ fmtBytes(raidBlockDev(r.name)!.usageTotal) }}</span>
                      </div>
                      <div class="h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                        <div class="h-full rounded-full" :class="usageBarClass(usagePct(raidBlockDev(r.name)!))" :style="{ width: usagePct(raidBlockDev(r.name)!) + '%' }"/>
                      </div>
                      <div class="text-[10px] text-[var(--c-text-3)] mt-1">{{ fmtBytes(raidBlockDev(r.name)!.usageFree) }} free · {{ usagePct(raidBlockDev(r.name)!).toFixed(1) }}%</div>
                    </div>
                    <div v-else-if="raidBlockDev(r.name)!.fstype" class="text-[11px] text-[var(--c-text-3)]">
                      Formatted <span class="font-mono text-[var(--c-text-2)]">{{ raidBlockDev(r.name)!.fstype }}</span> — not mounted
                    </div>
                    <div v-else class="text-[11px] text-[var(--c-text-3)] italic">No filesystem — format before mounting</div>
                  </div>
                  <div class="flex gap-1.5 shrink-0">
                    <button v-if="!raidBlockDev(r.name)!.mountpoint" @click="openFormat(raidBlockDev(r.name)!)"
                      class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                      Format
                    </button>
                    <button v-if="raidBlockDev(r.name)!.fstype && !raidBlockDev(r.name)!.mountpoint" @click="openMount(raidBlockDev(r.name)!)"
                      class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-green-500/50 hover:text-green-400 transition-colors">
                      Mount
                    </button>
                    <button v-if="raidBlockDev(r.name)!.mountpoint" @click="openUmount(raidBlockDev(r.name)!)"
                      class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-orange-500/50 hover:text-orange-400 transition-colors">
                      Unmount
                    </button>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </section>

      <!-- ══════════════════════════════════════════════════════════════════════ -->
      <!-- TAB: LVM                                                               -->
      <!-- ══════════════════════════════════════════════════════════════════════ -->
      <section v-if="activeTab === 'lvm'">
        <div class="flex items-center justify-between mb-3">
          <span v-if="lvmVGs.length" class="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--c-surface-deep)] text-[var(--c-text-3)] tabular-nums">{{ lvmVGs.length }} volume group{{ lvmVGs.length !== 1 ? 's' : '' }}</span>
          <button @click="openLvmWizard"
            class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
            Create VG
          </button>
        </div>

        <div v-if="lvmVGs.length === 0" class="rounded-xl border border-dashed border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-6 text-center text-sm text-[var(--c-text-3)]">
          No LVM volume groups. Create one to get resizable logical volumes from one or more physical drives.
        </div>

        <div v-else class="space-y-3">
          <div v-for="vg in lvmVGs" :key="vg.name"
            class="rounded-xl border bg-[var(--c-surface)] overflow-hidden flex"
            :class="isSystemVg(vg.name) ? 'border-orange-500/20' : 'border-[var(--c-border)]'">
            <!-- Left stripe -->
            <div class="w-0.5 shrink-0" :class="isSystemVg(vg.name) ? 'bg-orange-500/60' : 'bg-purple-500/50'"/>
            <div class="flex-1 min-w-0">
              <!-- VG header -->
              <div class="flex items-center gap-3 px-4 py-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-mono text-sm font-semibold text-[var(--c-text-1)]">{{ vg.name }}</span>
                    <span class="text-[11px] text-[var(--c-text-3)]">{{ fmtBytes(vg.size) }}</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">{{ vg.pvCount }} PV · {{ vg.lvCount }} LV</span>
                    <span v-if="isSystemVg(vg.name)" class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20">
                      <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                      SYSTEM
                    </span>
                  </div>
                  <!-- Capacity bar -->
                  <div class="mt-2 flex items-center gap-2">
                    <div class="flex-1 h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden max-w-[200px]">
                      <div class="h-full rounded-full bg-purple-400/70" :style="{ width: (100 - vgFreePct(vg)) + '%' }"/>
                    </div>
                    <span class="text-[10px] text-[var(--c-text-3)] tabular-nums shrink-0">{{ fmtBytes(vg.free) }} free</span>
                  </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <button v-if="!isSystemVg(vg.name)" @click="addLvDlg = { vg, lvName: 'lv' + vg.lvCount, lvSizeGB: 0, busy: false, err: '' }"
                    class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-purple-500/50 hover:text-purple-400 transition-colors">
                    + Add LV
                  </button>
                  <!-- ⋯ menu for VG -->
                  <div v-if="!isSystemVg(vg.name)" class="relative z-30">
                    <button @click.stop="openMenu = openMenu === ('vg:' + vg.name) ? null : ('vg:' + vg.name)"
                      :class="['w-7 h-7 flex items-center justify-center rounded-lg transition-colors', openMenu === ('vg:' + vg.name) ? 'bg-[var(--c-hover)] text-[var(--c-text-1)]' : 'text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)]']">
                      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
                      </svg>
                    </button>
                    <div v-if="openMenu === ('vg:' + vg.name)"
                      class="absolute right-0 top-full mt-1.5 bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl shadow-2xl overflow-hidden min-w-[176px]">
                      <div class="px-3 pt-2.5 pb-1.5 border-b border-[var(--c-border)]">
                        <p class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Danger zone</p>
                      </div>
                      <button @click="removeVgDlg = { vg, confirm: '', busy: false, err: '' }; openMenu = null"
                        class="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors text-left">
                        <svg class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                          <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/>
                        </svg>
                        Remove VG…
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- PVs -->
              <div class="px-4 py-2 border-t border-[var(--c-border)] bg-[var(--c-surface-deep)]/30">
                <div class="flex flex-wrap gap-1.5">
                  <span v-for="pv in lvmPVs.filter(p => p.vgName === vg.name)" :key="pv.name"
                    class="inline-flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded-md bg-[var(--c-surface-deep)] text-[var(--c-text-3)] border border-[var(--c-border)]">
                    {{ pv.name }} <span class="text-[var(--c-text-3)]/60">{{ fmtBytes(pv.size) }}</span>
                  </span>
                </div>
              </div>

              <!-- LVs -->
              <div class="divide-y divide-[var(--c-border)]">
                <div v-if="lvmLVs.filter(l => l.vgName === vg.name).length === 0"
                  class="px-4 py-3 text-[11px] italic text-[var(--c-text-3)]">
                  No logical volumes — click "+ Add LV" to create one.
                </div>
                <div v-for="lv in lvmLVs.filter(l => l.vgName === vg.name)" :key="lv.name"
                  class="group/lv flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--c-hover)]/30 transition-colors">
                  <div class="w-1.5 h-1.5 rounded-full shrink-0"
                    :class="lvToBlockDev(lv).isSystem ? 'bg-orange-400/70' : lvToBlockDev(lv).mountpoint ? 'bg-green-400/70' : 'bg-purple-400/40'"/>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="font-mono text-xs text-[var(--c-text-2)]">{{ lv.path }}</span>
                      <span class="text-[10px] text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(lv.size) }}</span>
                      <span v-if="lvToBlockDev(lv).fstype" class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--c-surface-deep)] text-[var(--c-text-3)] uppercase">{{ lvToBlockDev(lv).fstype }}</span>
                      <span v-else class="text-[10px] italic text-[var(--c-text-3)]">unformatted</span>
                    </div>
                    <div v-if="lvToBlockDev(lv).mountpoint" class="text-[10px] font-mono text-[var(--c-text-3)] mt-0.5">↳ {{ lvToBlockDev(lv).mountpoint }}</div>
                    <div v-if="lvToBlockDev(lv).usageTotal > 0" class="mt-1.5 flex items-center gap-2">
                      <div class="w-24 h-0.5 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                        <div class="h-full rounded-full" :class="usageBarClass(usagePct(lvToBlockDev(lv)))" :style="{ width: usagePct(lvToBlockDev(lv)) + '%' }"/>
                      </div>
                      <span class="text-[10px] text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(lvToBlockDev(lv).usageFree) }} free</span>
                    </div>
                  </div>
                  <!-- LV actions — revealed on hover, hidden by default -->
                  <div v-if="!lvToBlockDev(lv).isSystem" class="flex items-center gap-1 shrink-0 opacity-0 group-hover/lv:opacity-100 transition-opacity">
                    <button v-if="!lvToBlockDev(lv).mountpoint" @click="openFormat(lvToBlockDev(lv))"
                      class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">Format</button>
                    <button v-if="lvToBlockDev(lv).fstype && !lvToBlockDev(lv).mountpoint" @click="openMount(lvToBlockDev(lv))"
                      class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-green-500/50 hover:text-green-400 transition-colors">Mount</button>
                    <button v-if="lvToBlockDev(lv).mountpoint" @click="openUmount(lvToBlockDev(lv))"
                      class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-orange-500/50 hover:text-orange-400 transition-colors">Unmount</button>
                    <!-- Thin separator before destructive -->
                    <div class="w-px h-3 bg-[var(--c-border)] mx-1"/>
                    <button @click="removeLvDlg = { lv, confirm: '', busy: false, err: '' }"
                      title="Delete this logical volume"
                      class="w-6 h-6 flex items-center justify-center rounded text-[var(--c-text-3)]/40 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ══════════════════════════════════════════════════════════════════════ -->
      <!-- TAB: DISKS                                                             -->
      <!-- ══════════════════════════════════════════════════════════════════════ -->
      <section v-if="activeTab === 'disks'">
        <div v-if="physicalDisks.length === 0" class="text-sm text-[var(--c-text-3)]">No physical drives detected.</div>

        <div class="space-y-3">
          <div v-for="disk in physicalDisks" :key="disk.name"
            class="rounded-xl border bg-[var(--c-surface)] overflow-hidden flex"
            :class="disk.isSystem ? 'border-orange-500/20' : 'border-[var(--c-border)]'">
            <!-- Left stripe by type -->
            <div class="w-0.5 shrink-0"
              :class="disk.isSystem ? 'bg-orange-500/60' : disk.isRemovable ? 'bg-blue-500/50' : 'bg-[var(--c-border-strong)]'"/>
            <div class="flex-1 min-w-0">

              <!-- Disk header -->
              <div class="flex items-center gap-3 px-4 py-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-mono text-sm font-semibold text-[var(--c-text-1)]">/dev/{{ disk.name }}</span>
                    <span v-if="disk.model" class="text-[11px] text-[var(--c-text-3)] truncate">{{ disk.model }}</span>
                    <span class="text-[11px] text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(disk.size) }}</span>
                    <span v-if="disk.isSystem" class="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20">
                      <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                      SYSTEM
                    </span>
                    <span v-if="disk.isRemovable" class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">USB</span>
                  </div>
                  <div v-if="disk.isSystem" class="text-[10px] text-orange-400/70 mt-0.5">Operating system disk — no modifications allowed</div>
                </div>
                <!-- + Partition button (non-system only) -->
                <button v-if="!disk.isSystem" @click="partCreateDlg = { disk, busy: false, err: '' }"
                  class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors shrink-0">
                  + Partition
                </button>
              </div>

              <!-- Partitions -->
              <div v-if="disk.children && disk.children.length > 0" class="border-t border-[var(--c-border)] divide-y divide-[var(--c-border)]">
                <div v-for="part in disk.children.filter(c => c.type !== 'swap')" :key="part.name"
                  class="group/part flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--c-hover)]/30 transition-colors">
                  <!-- Status dot -->
                  <div class="w-1.5 h-1.5 rounded-full shrink-0"
                    :class="part.isSystem ? 'bg-orange-400/60' : part.mountpoint ? 'bg-green-400/70' : 'bg-[var(--c-text-3)]/25'"/>
                  <!-- Info -->
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="font-mono text-xs text-[var(--c-text-2)]">/dev/{{ part.name }}</span>
                      <span class="text-[10px] text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(part.size) }}</span>
                      <span v-if="part.fstype" class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--c-surface-deep)] text-[var(--c-text-3)] uppercase border border-[var(--c-border)]">{{ part.fstype }}</span>
                      <span v-else class="text-[10px] italic text-[var(--c-text-3)]/60">unformatted</span>
                    </div>
                    <div v-if="part.mountpoint" class="text-[10px] font-mono text-[var(--c-text-3)] mt-0.5">↳ {{ part.mountpoint }}</div>
                    <div v-if="part.usageTotal > 0" class="mt-1.5 flex items-center gap-2">
                      <div class="w-24 h-0.5 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                        <div class="h-full rounded-full" :class="usageBarClass(usagePct(part))" :style="{ width: usagePct(part) + '%' }"/>
                      </div>
                      <span class="text-[10px] text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(part.usageFree) }} free</span>
                    </div>
                  </div>
                  <!-- Actions — revealed on hover, hidden by default -->
                  <div v-if="!part.isSystem" class="flex items-center gap-1 shrink-0 opacity-0 group-hover/part:opacity-100 transition-opacity">
                    <button v-if="!part.mountpoint" @click="openFormat(part)"
                      class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">Format</button>
                    <button v-if="part.fstype && !part.mountpoint" @click="openMount(part)"
                      class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-green-500/50 hover:text-green-400 transition-colors">Mount</button>
                    <button v-if="part.mountpoint" @click="openUmount(part)"
                      class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-orange-500/50 hover:text-orange-400 transition-colors">Unmount</button>
                    <div class="w-px h-3 bg-[var(--c-border)] mx-1"/>
                    <button v-if="!part.mountpoint" @click="partDeleteDlg = { disk, part, busy: false, err: '' }"
                      title="Delete this partition"
                      class="w-6 h-6 flex items-center justify-center rounded text-[var(--c-text-3)]/40 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              <!-- Unpartitioned raw disk -->
              <div v-else-if="!disk.isSystem" class="border-t border-[var(--c-border)] flex items-center gap-3 px-4 py-2.5">
                <div class="w-1.5 h-1.5 rounded-full shrink-0" :class="disk.fstype ? 'bg-[var(--c-accent)]/60' : 'bg-[var(--c-text-3)]/20'"/>
                <div class="flex-1 min-w-0">
                  <span v-if="disk.fstype" class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--c-surface-deep)] text-[var(--c-text-3)] uppercase border border-[var(--c-border)]">{{ disk.fstype }}</span>
                  <span v-else class="text-[11px] italic text-[var(--c-text-3)]/60">Raw disk — no partition table</span>
                  <div v-if="disk.mountpoint" class="text-[10px] font-mono text-[var(--c-text-3)] mt-0.5">↳ {{ disk.mountpoint }}</div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button v-if="!disk.mountpoint" @click="openFormat(disk)"
                    class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">Format</button>
                  <button v-if="disk.fstype && !disk.mountpoint" @click="openMount(disk)"
                    class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-green-500/50 hover:text-green-400 transition-colors">Mount</button>
                  <button v-if="disk.mountpoint" @click="openUmount(disk)"
                    class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-orange-500/50 hover:text-orange-400 transition-colors">Unmount</button>
                </div>
              </div>

              <!-- Expandable danger zone (non-system disks only) -->
              <div v-if="!disk.isSystem" class="border-t border-[var(--c-border)]">
                <button @click="toggleDanger(disk.name)"
                  class="w-full flex items-center gap-2 px-4 py-2 text-[10px] text-[var(--c-text-3)]/60 hover:text-[var(--c-text-3)] transition-colors">
                  <svg class="w-3 h-3 shrink-0 transition-transform" :class="dangerDisks.has(disk.name) ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                  </svg>
                  Advanced
                </button>
                <div v-if="dangerDisks.has(disk.name)" class="px-4 pb-3 pt-0.5">
                  <div class="flex items-start gap-3 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
                    <svg class="w-3.5 h-3.5 text-red-400/70 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                    </svg>
                    <div class="flex-1 min-w-0">
                      <p class="text-[11px] text-[var(--c-text-2)] font-medium mb-0.5">Initialize GPT partition table</p>
                      <p class="text-[10px] text-[var(--c-text-3)]">Completely erases all existing partitions and data on <span class="font-mono">/dev/{{ disk.name }}</span>. Use only to prepare a blank disk.</p>
                      <button @click="partInitDlg = { disk, confirm: '', busy: false, err: '' }"
                        class="mt-2 text-[11px] px-2.5 py-1 rounded border border-red-500/30 text-red-400/80 hover:border-red-500/60 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                        Init GPT…
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

    </template>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- FORMAT WIZARD                                                        -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="formatWiz" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="formatWiz = null">
        <div class="w-full max-w-md bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl shadow-2xl overflow-hidden">

          <!-- Step indicator -->
          <div class="flex items-center gap-0 border-b border-[var(--c-border)]">
            <div v-for="(label, i) in ['Warning', 'Filesystem', 'Confirm']" :key="i"
              :class="['flex-1 py-2.5 text-center text-[11px] font-semibold transition-colors',
                formatWiz.step === i + 1 ? 'text-[var(--c-accent)] border-b-2 border-[var(--c-accent)]'
                : formatWiz.step > i + 1  ? 'text-[var(--c-text-3)]'
                : 'text-[var(--c-text-3)]/50']"
            >{{ i + 1 }}. {{ label }}</div>
          </div>

          <!-- Step 1: Warning -->
          <div v-if="formatWiz.step === 1" class="p-6 space-y-4">
            <div class="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/30">
              <svg class="w-5 h-5 text-red-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <div>
                <div class="font-semibold text-red-400 text-sm mb-1">All data will be permanently erased</div>
                <div class="text-xs text-red-300/80">
                  Formatting <span class="font-mono font-bold">/dev/{{ formatWiz.dev.name }}</span> will destroy every file currently on this device. This operation cannot be undone.
                </div>
              </div>
            </div>

            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Device</span><span class="font-mono">/dev/{{ formatWiz.dev.name }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(formatWiz.dev.size) }}</span></div>
              <div v-if="formatWiz.dev.fstype" class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Current FS</span><span class="font-mono">{{ formatWiz.dev.fstype }}</span></div>
              <div v-if="formatWiz.dev.model" class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Model</span><span>{{ formatWiz.dev.model }}</span></div>
            </div>

            <div class="flex gap-2 pt-2">
              <button @click="formatWiz = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="formatWiz.step = 2" class="flex-1 py-2 text-sm rounded-lg bg-[var(--c-accent)] text-white hover:opacity-90 transition-opacity">I understand, continue →</button>
            </div>
          </div>

          <!-- Step 2: Choose filesystem -->
          <div v-else-if="formatWiz.step === 2" class="p-6 space-y-3">
            <p class="text-sm text-[var(--c-text-2)] font-medium mb-2">Choose a filesystem for <span class="font-mono text-[var(--c-text-1)]">/dev/{{ formatWiz.dev.name }}</span></p>

            <div class="space-y-2">
              <label
                v-for="fs in FS_OPTIONS" :key="fs.id"
                :class="['flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors',
                  formatWiz.fstype === fs.id
                    ? 'border-[var(--c-accent)] bg-[var(--c-accent)]/5'
                    : 'border-[var(--c-border)] hover:border-[var(--c-border-strong)]']"
                @click="formatWiz.fstype = fs.id"
              >
                <div class="mt-0.5">
                  <div :class="['w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors',
                    formatWiz.fstype === fs.id ? 'border-[var(--c-accent)]' : 'border-[var(--c-border-strong)]']">
                    <div v-if="formatWiz.fstype === fs.id" class="w-2 h-2 rounded-full bg-[var(--c-accent)]"/>
                  </div>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold text-[var(--c-text-1)]">{{ fs.name }}</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded-full"
                      :class="fs.tag === 'Recommended' ? 'bg-green-500/15 text-green-400' : 'bg-[var(--c-surface-deep)] text-[var(--c-text-3)]'"
                    >{{ fs.tag }}</span>
                  </div>
                  <div class="text-xs text-[var(--c-text-3)] mt-0.5 leading-relaxed">{{ fs.desc }}</div>
                </div>
              </label>
            </div>

            <div class="pt-1">
              <label class="block text-xs text-[var(--c-text-2)] mb-1">Volume label <span class="text-[var(--c-text-3)]">(optional)</span></label>
              <input
                v-model="formatWiz.label"
                type="text"
                placeholder="e.g. Data, Backup, Media"
                maxlength="64"
                class="w-full px-3 py-2 text-sm rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-[var(--c-accent)] transition-colors"
              />
            </div>

            <div class="flex gap-2 pt-1">
              <button @click="formatWiz.step = 1" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">← Back</button>
              <button @click="formatWiz.step = 3" class="flex-1 py-2 text-sm rounded-lg bg-[var(--c-accent)] text-white hover:opacity-90 transition-opacity">Next →</button>
            </div>
          </div>

          <!-- Step 3: Confirm -->
          <div v-else-if="formatWiz.step === 3" class="p-6 space-y-4">
            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Device</span><span class="font-mono">/dev/{{ formatWiz.dev.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(formatWiz.dev.size) }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Filesystem</span><span class="font-mono">{{ formatWiz.fstype }}</span></div>
              <div v-if="formatWiz.label" class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Label</span><span>{{ formatWiz.label }}</span></div>
            </div>

            <div>
              <label class="block text-xs text-[var(--c-text-2)] mb-1.5">
                Type <span class="font-mono font-bold text-[var(--c-text-1)]">{{ formatWiz.dev.name }}</span> to confirm
              </label>
              <input
                v-model="formatWiz.confirm"
                type="text"
                :placeholder="formatWiz.dev.name"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-red-500 transition-colors"
              />
            </div>

            <div v-if="formatWiz.err" class="text-xs text-red-400 px-1">{{ formatWiz.err }}</div>

            <div class="flex gap-2">
              <button @click="formatWiz.step = 2" :disabled="formatWiz.busy" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors disabled:opacity-50">← Back</button>
              <button
                @click="doFormat"
                :disabled="formatWiz.confirm !== formatWiz.dev.name || formatWiz.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
              >
                <span v-if="formatWiz.busy">Formatting…</span>
                <span v-else>Format now</span>
              </button>
            </div>
          </div>

        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- MOUNT DIALOG                                                         -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="mountDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="mountDlg = null">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl shadow-2xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)]">
            <h3 class="font-semibold text-[var(--c-text-1)]">Mount device</h3>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">
              <span class="font-mono">{{ mountDlg.dev.path }}</span>
              <span v-if="mountDlg.dev.fstype"> · {{ mountDlg.dev.fstype }}</span>
              · {{ fmtBytes(mountDlg.dev.size) }}
            </p>
          </div>
          <div class="p-5 space-y-4">
            <div>
              <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">Mount point</label>
              <input
                v-model="mountDlg.mp"
                type="text"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)] transition-colors"
              />
              <p class="text-[10px] text-[var(--c-text-3)] mt-1">Directory will be created if it doesn't exist.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">Mount options</label>
              <input
                v-model="mountDlg.options"
                type="text"
                placeholder="defaults"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)] transition-colors"
              />
            </div>
            <label class="flex items-start gap-2.5 cursor-pointer">
              <input v-model="mountDlg.persist" type="checkbox" class="mt-0.5 accent-[var(--c-accent)]"/>
              <div>
                <div class="text-xs font-medium text-[var(--c-text-2)]">Persist across reboots</div>
                <div class="text-[10px] text-[var(--c-text-3)]">Add a UUID-based entry to /etc/fstab so the drive is auto-mounted on boot.</div>
              </div>
            </label>
            <div v-if="mountDlg.err" class="text-xs text-red-400">{{ mountDlg.err }}</div>
            <div class="flex gap-2 pt-1">
              <button @click="mountDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doMount" :disabled="!mountDlg.mp || mountDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-[var(--c-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed font-medium">
                <span v-if="mountDlg.busy">Mounting…</span>
                <span v-else>Mount</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- UNMOUNT DIALOG                                                       -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="umountDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="umountDlg = null">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl shadow-2xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)]">
            <h3 class="font-semibold text-[var(--c-text-1)]">Unmount device</h3>
          </div>
          <div class="p-5 space-y-4">
            <div class="p-3 rounded-lg bg-orange-500/5 border border-orange-500/15 text-xs text-orange-400">
              Make sure no application is using files on <span class="font-mono font-bold">{{ umountDlg.dev.mountpoint }}</span> before unmounting, or the operation will fail.
            </div>
            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Device</span><span class="font-mono">/dev/{{ umountDlg.dev.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Mount point</span><span class="font-mono">{{ umountDlg.dev.mountpoint }}</span></div>
            </div>
            <label class="flex items-start gap-2.5 cursor-pointer">
              <input v-model="umountDlg.rmFstab" type="checkbox" class="mt-0.5 accent-[var(--c-accent)]"/>
              <div>
                <div class="text-xs font-medium text-[var(--c-text-2)]">Remove from /etc/fstab</div>
                <div class="text-[10px] text-[var(--c-text-3)]">Also delete the auto-mount entry so the drive stays unmounted after reboots.</div>
              </div>
            </label>
            <div v-if="umountDlg.err" class="text-xs text-red-400">{{ umountDlg.err }}</div>
            <div class="flex gap-2 pt-1">
              <button @click="umountDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doUmount" :disabled="umountDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-40 font-medium">
                <span v-if="umountDlg.busy">Unmounting…</span>
                <span v-else>Unmount</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- CREATE RAID WIZARD                                                   -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="raidWiz" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="raidWiz = null">
        <div class="w-full max-w-lg bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl shadow-2xl overflow-hidden">

          <!-- Step indicator -->
          <div class="flex items-center gap-0 border-b border-[var(--c-border)]">
            <div v-for="(label, i) in ['RAID Level', 'Select Drives', 'Confirm']" :key="i"
              :class="['flex-1 py-2.5 text-center text-[11px] font-semibold transition-colors',
                raidWiz.step === i + 1 ? 'text-[var(--c-accent)] border-b-2 border-[var(--c-accent)]'
                : raidWiz.step > i + 1  ? 'text-[var(--c-text-3)]'
                : 'text-[var(--c-text-3)]/50']"
            >{{ i + 1 }}. {{ label }}</div>
          </div>

          <!-- Step 1: Choose RAID level -->
          <div v-if="raidWiz.step === 1" class="p-5 space-y-3">
            <p class="text-sm text-[var(--c-text-3)]">Choose the RAID configuration that matches your needs.</p>

            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="lvl in RAID_LEVELS" :key="lvl.level"
                @click="raidWiz.level = lvl.level"
                :class="['text-left p-3 rounded-xl border transition-colors',
                  raidWiz.level === lvl.level
                    ? 'border-[var(--c-accent)] bg-[var(--c-accent)]/5'
                    : 'border-[var(--c-border)] hover:border-[var(--c-border-strong)]']"
              >
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-sm font-bold text-[var(--c-text-1)]">{{ lvl.name }}</span>
                  <span class="text-[10px] text-[var(--c-text-3)]">{{ lvl.sub }}</span>
                </div>
                <div class="text-[11px] text-[var(--c-text-3)] leading-relaxed">{{ lvl.desc }}</div>
                <div class="flex items-center gap-3 mt-2 text-[10px]">
                  <span class="text-[var(--c-text-3)]">Min: {{ lvl.minDev }} drives</span>
                  <span :class="lvl.redundancy === 'None' ? 'text-red-400' : 'text-green-400'">
                    Redundancy: {{ lvl.redundancy }}
                  </span>
                </div>
              </button>
            </div>

            <!-- Selected level danger notice -->
            <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/5 border border-yellow-500/20 text-[11px] text-yellow-400">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <span>{{ selectedRaidLevel.danger }}</span>
            </div>

            <div class="flex gap-2 pt-1">
              <button @click="raidWiz = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="raidWiz.step = 2" class="flex-1 py-2 text-sm rounded-lg bg-[var(--c-accent)] text-white hover:opacity-90 transition-opacity">Next →</button>
            </div>
          </div>

          <!-- Step 2: Select drives -->
          <div v-else-if="raidWiz.step === 2" class="p-5 space-y-3">
            <p class="text-sm text-[var(--c-text-2)]">
              Select drives for <strong>{{ selectedRaidLevel.name }}</strong>.
              <span class="text-[var(--c-text-3)]">Minimum {{ selectedRaidLevel.minDev }} required.</span>
            </p>

            <!-- Capacity hint -->
            <div class="text-[11px] text-[var(--c-text-3)] px-1">{{ selectedRaidLevel.capacityHint }}</div>

            <div v-if="eligibleForRaid.length === 0" class="py-6 text-center text-sm text-[var(--c-text-3)]">
              No eligible drives available.<br>
              <span class="text-xs">Drives must be unmounted, not already in a RAID or LVM, and not a system disk.</span>
            </div>

            <div v-else class="space-y-1.5 max-h-60 overflow-y-auto pr-1">
              <label
                v-for="dev in eligibleForRaid" :key="dev.name"
                :class="['flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors',
                  raidWiz.devs.includes(dev.name)
                    ? 'border-[var(--c-accent)] bg-[var(--c-accent)]/5'
                    : 'border-[var(--c-border)] hover:border-[var(--c-border-strong)]']"
                @click="toggleRaidDev(dev.name)"
              >
                <div :class="['w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                  raidWiz.devs.includes(dev.name) ? 'border-[var(--c-accent)] bg-[var(--c-accent)]' : 'border-[var(--c-border-strong)]']">
                  <svg v-if="raidWiz.devs.includes(dev.name)" class="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                  </svg>
                </div>
                <div class="flex-1 min-w-0">
                  <span class="text-sm font-mono text-[var(--c-text-1)]">/dev/{{ dev.name }}</span>
                  <span v-if="dev.model" class="text-xs text-[var(--c-text-3)] ml-2">{{ dev.model }}</span>
                </div>
                <span class="text-xs text-[var(--c-text-3)] shrink-0">{{ fmtBytes(dev.size) }}</span>
              </label>
            </div>

            <div v-if="raidWiz.devs.length > 0 && !raidCanAdvance" class="text-[11px] text-yellow-400 px-1">
              {{ selectedRaidLevel.name }} requires at least {{ selectedRaidLevel.minDev }} drives ({{ raidWiz.devs.length }} selected).
            </div>

            <!-- Array name -->
            <div>
              <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">Array name</label>
              <input
                v-model="raidWiz.name"
                type="text"
                placeholder="md0"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)] transition-colors"
              />
              <p class="text-[10px] text-[var(--c-text-3)] mt-1">Will create <span class="font-mono">/dev/{{ raidWiz.name || 'md0' }}</span></p>
            </div>

            <div class="flex gap-2 pt-1">
              <button @click="raidWiz.step = 1" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">← Back</button>
              <button @click="raidWiz.step = 3" :disabled="!raidCanAdvance || !raidWiz.name"
                class="flex-1 py-2 text-sm rounded-lg bg-[var(--c-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
                Next →
              </button>
            </div>
          </div>

          <!-- Step 3: Confirm -->
          <div v-else-if="raidWiz.step === 3" class="p-5 space-y-4">
            <div class="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/30">
              <svg class="w-5 h-5 text-red-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <div>
                <div class="font-semibold text-red-400 text-sm mb-1">All data on selected drives will be erased</div>
                <div class="text-xs text-red-300/80">
                  Creating this RAID array will permanently destroy all existing data on the selected drives. This cannot be undone.
                </div>
              </div>
            </div>

            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Array</span><span class="font-mono">/dev/{{ raidWiz.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Level</span><span>{{ selectedRaidLevel.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Drives</span><span class="font-mono">{{ raidWiz.devs.join(', ') }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Capacity</span><span>{{ selectedRaidLevel.capacityHint }}</span></div>
            </div>

            <div>
              <label class="block text-xs text-[var(--c-text-2)] mb-1.5">
                Type <span class="font-mono font-bold text-[var(--c-text-1)]">CREATE RAID</span> to confirm
              </label>
              <input
                v-model="raidWiz.confirm"
                type="text"
                placeholder="CREATE RAID"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-red-500 transition-colors"
              />
            </div>

            <div v-if="raidWiz.err" class="text-xs text-red-400 px-1">{{ raidWiz.err }}</div>

            <div class="flex gap-2">
              <button @click="raidWiz.step = 2" :disabled="raidWiz.busy" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors disabled:opacity-50">← Back</button>
              <button
                @click="doCreateRaid"
                :disabled="raidWiz.confirm !== 'CREATE RAID' || raidWiz.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
              >
                <span v-if="raidWiz.busy">Creating…</span>
                <span v-else>Create RAID</span>
              </button>
            </div>
          </div>

        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- LVM CREATE WIZARD                                                     -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="lvmWiz" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="!lvmWiz.busy && (lvmWiz = null)">
        <div class="w-full max-w-md bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl shadow-2xl overflow-hidden">

          <!-- Step indicator -->
          <div class="flex items-center border-b border-[var(--c-border)]">
            <div v-for="(label, i) in ['Select Devices', 'Configure', 'Confirm']" :key="i"
              :class="['flex-1 py-2.5 text-center text-[11px] font-semibold transition-colors',
                lvmWiz.step === i + 1 ? 'text-purple-400 border-b-2 border-purple-400'
                : lvmWiz.step > i + 1  ? 'text-[var(--c-text-3)]'
                : 'text-[var(--c-text-3)]/50']"
            >{{ i + 1 }}. {{ label }}</div>
          </div>

          <!-- Step 1: Select devices -->
          <div v-if="lvmWiz.step === 1" class="p-5 space-y-3">
            <p class="text-sm text-[var(--c-text-2)]">
              Select one or more devices to become Physical Volumes (PVs). They will be combined into a Volume Group.
            </p>
            <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/5 border border-yellow-500/20 text-[11px] text-yellow-400">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              All data on the selected devices will be permanently destroyed.
            </div>
            <div v-if="eligibleForLvm.length === 0" class="py-6 text-center text-sm text-[var(--c-text-3)]">
              No eligible devices available.<br>
              <span class="text-xs">Devices must be unmounted, not already a PV, and not a system disk.</span>
            </div>
            <div v-else class="space-y-1.5 max-h-52 overflow-y-auto pr-1">
              <label v-for="dev in eligibleForLvm" :key="dev.name"
                :class="['flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors',
                  lvmWiz.pvDevs.includes(dev.name)
                    ? 'border-purple-400 bg-purple-400/5'
                    : 'border-[var(--c-border)] hover:border-[var(--c-border-strong)]']"
                @click="toggleLvmDev(dev.name)">
                <div :class="['w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                  lvmWiz.pvDevs.includes(dev.name) ? 'border-purple-400 bg-purple-400' : 'border-[var(--c-border-strong)]']">
                  <svg v-if="lvmWiz.pvDevs.includes(dev.name)" class="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                  </svg>
                </div>
                <div class="flex-1 min-w-0">
                  <span class="text-sm font-mono text-[var(--c-text-1)]">/dev/{{ dev.name }}</span>
                  <span v-if="dev.type === 'md'" class="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-[var(--c-accent)]/10 text-[var(--c-accent)]">RAID</span>
                  <span v-else-if="dev.model" class="text-xs text-[var(--c-text-3)] ml-2">{{ dev.model }}</span>
                </div>
                <span class="text-xs text-[var(--c-text-3)] shrink-0">{{ fmtBytes(dev.size) }}</span>
              </label>
            </div>
            <div class="flex gap-2 pt-1">
              <button @click="lvmWiz = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="lvmWiz.step = 2" :disabled="lvmWiz.pvDevs.length === 0"
                class="flex-1 py-2 text-sm rounded-lg bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                Next →
              </button>
            </div>
          </div>

          <!-- Step 2: Configure VG + LV -->
          <div v-else-if="lvmWiz.step === 2" class="p-5 space-y-4">
            <p class="text-sm text-[var(--c-text-2)]">Name the Volume Group and its first Logical Volume.</p>
            <div>
              <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">Volume Group name</label>
              <input v-model="lvmWiz.vgName" type="text" placeholder="vg0"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-purple-400 transition-colors"/>
              <p class="text-[10px] text-[var(--c-text-3)] mt-1">Letters, digits, underscores, hyphens. Must start with a letter.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">First Logical Volume name</label>
              <input v-model="lvmWiz.lvName" type="text" placeholder="lv0"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-purple-400 transition-colors"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">
                Size (GB) <span class="text-[var(--c-text-3)] font-normal">— leave 0 to use all available space</span>
              </label>
              <input v-model.number="lvmWiz.lvSizeGB" type="number" min="0" placeholder="0"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-purple-400 transition-colors"/>
            </div>
            <div class="flex gap-2 pt-1">
              <button @click="lvmWiz.step = 1" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">← Back</button>
              <button @click="lvmWiz.step = 3" :disabled="!lvmWiz.vgName || !lvmWiz.lvName"
                class="flex-1 py-2 text-sm rounded-lg bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                Next →
              </button>
            </div>
          </div>

          <!-- Step 3: Confirm -->
          <div v-else-if="lvmWiz.step === 3" class="p-5 space-y-4">
            <div class="flex items-start gap-3 p-4 rounded-xl bg-yellow-500/10 border border-yellow-500/30">
              <svg class="w-5 h-5 text-yellow-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <div>
                <div class="font-semibold text-yellow-400 text-sm mb-1">All data on selected devices will be erased</div>
                <div class="text-xs text-yellow-300/80">LVM will overwrite the beginning of each device to write PV headers.</div>
              </div>
            </div>
            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Devices</span><span class="font-mono">{{ lvmWiz.pvDevs.join(', ') }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">VG name</span><span class="font-mono">{{ lvmWiz.vgName }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">LV name</span><span class="font-mono">{{ lvmWiz.lvName }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">LV size</span><span>{{ lvmWiz.lvSizeGB > 0 ? lvmWiz.lvSizeGB + ' GB' : 'All free space' }}</span></div>
            </div>
            <div v-if="lvmWiz.err" class="text-xs text-red-400 px-1">{{ lvmWiz.err }}</div>
            <div class="flex gap-2">
              <button @click="lvmWiz.step = 2" :disabled="lvmWiz.busy" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors disabled:opacity-50">← Back</button>
              <button @click="doCreateLvm" :disabled="lvmWiz.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-40 font-medium">
                <span v-if="lvmWiz.busy">Creating…</span>
                <span v-else>Create LVM</span>
              </button>
            </div>
          </div>

        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- ADD LV DIALOG                                                         -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="addLvDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="!addLvDlg.busy && (addLvDlg = null)">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl shadow-2xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)]">
            <h3 class="font-semibold text-[var(--c-text-1)]">Add Logical Volume</h3>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">VG <span class="font-mono text-purple-400">{{ addLvDlg.vg.name }}</span> · {{ fmtBytes(addLvDlg.vg.free) }} free</p>
          </div>
          <div class="p-5 space-y-4">
            <div>
              <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">Logical Volume name</label>
              <input v-model="addLvDlg.lvName" type="text" placeholder="lv0"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-purple-400 transition-colors"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">
                Size (GB) <span class="text-[var(--c-text-3)] font-normal">— 0 = all remaining free space</span>
              </label>
              <input v-model.number="addLvDlg.lvSizeGB" type="number" min="0" placeholder="0"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-purple-400 transition-colors"/>
            </div>
            <div v-if="addLvDlg.err" class="text-xs text-red-400">{{ addLvDlg.err }}</div>
            <div class="flex gap-2 pt-1">
              <button @click="addLvDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doAddLv" :disabled="!addLvDlg.lvName || addLvDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-40 font-medium">
                <span v-if="addLvDlg.busy">Creating…</span>
                <span v-else>Create LV</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- REMOVE LV DIALOG                                                      -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="removeLvDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="!removeLvDlg.busy && (removeLvDlg = null)">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-red-500/30 rounded-2xl shadow-2xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)] bg-red-500/5">
            <h3 class="font-semibold text-red-400">Delete Logical Volume</h3>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              All data on <span class="font-mono font-bold">{{ removeLvDlg.lv.path }}</span> will be permanently destroyed.
            </div>
            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">LV</span><span class="font-mono">{{ removeLvDlg.lv.path }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">VG</span><span class="font-mono">{{ removeLvDlg.lv.vgName }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(removeLvDlg.lv.size) }}</span></div>
            </div>
            <div>
              <label class="block text-xs text-[var(--c-text-2)] mb-1.5">
                Type <span class="font-mono font-bold text-[var(--c-text-1)]">{{ removeLvDlg.lv.name }}</span> to confirm
              </label>
              <input v-model="removeLvDlg.confirm" type="text" :placeholder="removeLvDlg.lv.name"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-red-500 transition-colors"/>
            </div>
            <div v-if="removeLvDlg.err" class="text-xs text-red-400">{{ removeLvDlg.err }}</div>
            <div class="flex gap-2">
              <button @click="removeLvDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doRemoveLv" :disabled="removeLvDlg.confirm !== removeLvDlg.lv.name || removeLvDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40 font-medium">
                <span v-if="removeLvDlg.busy">Deleting…</span>
                <span v-else>Delete LV</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- REMOVE VG DIALOG                                                      -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="removeVgDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="!removeVgDlg.busy && (removeVgDlg = null)">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-red-500/30 rounded-2xl shadow-2xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)] bg-red-500/5">
            <h3 class="font-semibold text-red-400">Remove Volume Group</h3>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">This will delete the VG and all its Logical Volumes.</p>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              Removing <span class="font-mono font-bold">{{ removeVgDlg.vg.name }}</span> will destroy all {{ removeVgDlg.vg.lvCount }} Logical Volume(s) and their data.
            </div>
            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">VG</span><span class="font-mono">{{ removeVgDlg.vg.name }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(removeVgDlg.vg.size) }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">PVs</span><span>{{ removeVgDlg.vg.pvCount }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">LVs</span><span>{{ removeVgDlg.vg.lvCount }}</span></div>
            </div>
            <div>
              <label class="block text-xs text-[var(--c-text-2)] mb-1.5">
                Type <span class="font-mono font-bold text-[var(--c-text-1)]">{{ removeVgDlg.vg.name }}</span> to confirm
              </label>
              <input v-model="removeVgDlg.confirm" type="text" :placeholder="removeVgDlg.vg.name"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-red-500 transition-colors"/>
            </div>
            <div v-if="removeVgDlg.err" class="text-xs text-red-400">{{ removeVgDlg.err }}</div>
            <div class="flex gap-2">
              <button @click="removeVgDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doRemoveVg" :disabled="removeVgDlg.confirm !== removeVgDlg.vg.name || removeVgDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40 font-medium">
                <span v-if="removeVgDlg.busy">Removing…</span>
                <span v-else>Remove VG</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- INIT GPT DIALOG                                                       -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="partInitDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="!partInitDlg.busy && (partInitDlg = null)">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-red-500/30 rounded-2xl shadow-2xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)] bg-red-500/5">
            <h3 class="font-semibold text-red-400">Initialize GPT partition table</h3>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">This will erase all existing partitions and data on the disk.</p>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <span>Writing a new GPT label to <span class="font-mono font-bold">/dev/{{ partInitDlg.disk.name }}</span> will permanently destroy all partitions and data currently on the disk.</span>
            </div>
            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Disk</span><span class="font-mono">/dev/{{ partInitDlg.disk.name }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(partInitDlg.disk.size) }}</span></div>
              <div v-if="partInitDlg.disk.model" class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Model</span><span>{{ partInitDlg.disk.model }}</span></div>
            </div>
            <div>
              <label class="block text-xs text-[var(--c-text-2)] mb-1.5">
                Type <span class="font-mono font-bold text-[var(--c-text-1)]">{{ partInitDlg.disk.name }}</span> to confirm
              </label>
              <input v-model="partInitDlg.confirm" type="text" :placeholder="partInitDlg.disk.name"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-red-500 transition-colors"/>
            </div>
            <div v-if="partInitDlg.err" class="text-xs text-red-400">{{ partInitDlg.err }}</div>
            <div class="flex gap-2">
              <button @click="partInitDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doPartInit" :disabled="partInitDlg.confirm !== partInitDlg.disk.name || partInitDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40 font-medium">
                <span v-if="partInitDlg.busy">Initializing…</span>
                <span v-else>Init GPT</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- ADD PARTITION DIALOG                                                  -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="partCreateDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="!partCreateDlg.busy && (partCreateDlg = null)">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl shadow-2xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)]">
            <h3 class="font-semibold text-[var(--c-text-1)]">Add partition</h3>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">Creates a new partition spanning all available free space on <span class="font-mono">/dev/{{ partCreateDlg.disk.name }}</span>.</p>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-[var(--c-surface-deep)] border border-[var(--c-border)] text-xs text-[var(--c-text-3)]">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--c-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              The partition will use the entire free space (0% → 100%). After creation you can format and mount it.
            </div>
            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Disk</span><span class="font-mono">/dev/{{ partCreateDlg.disk.name }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Disk size</span><span>{{ fmtBytes(partCreateDlg.disk.size) }}</span></div>
            </div>
            <div v-if="partCreateDlg.err" class="text-xs text-red-400">{{ partCreateDlg.err }}</div>
            <div class="flex gap-2 pt-1">
              <button @click="partCreateDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doPartCreate" :disabled="partCreateDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-[var(--c-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 font-medium">
                <span v-if="partCreateDlg.busy">Creating…</span>
                <span v-else>Create partition</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- DELETE PARTITION DIALOG                                               -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="partDeleteDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="!partDeleteDlg.busy && (partDeleteDlg = null)">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-red-500/30 rounded-2xl shadow-2xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)] bg-red-500/5">
            <h3 class="font-semibold text-red-400">Delete partition</h3>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              Deleting <span class="font-mono font-bold">/dev/{{ partDeleteDlg.part.name }}</span> will permanently destroy all data in that partition.
            </div>
            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Partition</span><span class="font-mono">/dev/{{ partDeleteDlg.part.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(partDeleteDlg.part.size) }}</span></div>
              <div v-if="partDeleteDlg.part.fstype" class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Filesystem</span><span class="font-mono">{{ partDeleteDlg.part.fstype }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Disk</span><span class="font-mono">/dev/{{ partDeleteDlg.disk.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Partition #</span><span class="font-mono">{{ partNumOf(partDeleteDlg.disk.name, partDeleteDlg.part.name) }}</span></div>
            </div>
            <div v-if="partDeleteDlg.err" class="text-xs text-red-400">{{ partDeleteDlg.err }}</div>
            <div class="flex gap-2">
              <button @click="partDeleteDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doPartDelete" :disabled="partDeleteDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40 font-medium">
                <span v-if="partDeleteDlg.busy">Deleting…</span>
                <span v-else>Delete partition</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- DESTROY RAID DIALOG                                                  -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="destroyDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="destroyDlg = null">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-red-500/30 rounded-2xl shadow-2xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)] bg-red-500/5">
            <h3 class="font-semibold text-red-400">Destroy RAID array</h3>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">This will stop the array and erase RAID metadata from all member drives.</p>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <span>All data on <span class="font-mono font-bold">/dev/{{ destroyDlg.raid.name }}</span> will be permanently lost. Make sure you have a backup.</span>
            </div>

            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Array</span><span class="font-mono">/dev/{{ destroyDlg.raid.name }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Level</span><span>{{ raidLevelLabel(destroyDlg.raid.level) }}</span></div>
              <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Members</span><span class="font-mono">{{ destroyDlg.raid.devices.join(', ') }}</span></div>
            </div>

            <div>
              <label class="block text-xs text-[var(--c-text-2)] mb-1.5">
                Type <span class="font-mono font-bold text-[var(--c-text-1)]">{{ destroyDlg.raid.name }}</span> to confirm
              </label>
              <input
                v-model="destroyDlg.confirm"
                type="text"
                :placeholder="destroyDlg.raid.name"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-red-500 transition-colors"
              />
            </div>

            <div v-if="destroyDlg.err" class="text-xs text-red-400">{{ destroyDlg.err }}</div>

            <div class="flex gap-2">
              <button @click="destroyDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button
                @click="doDestroyRaid"
                :disabled="destroyDlg.confirm !== destroyDlg.raid.name || destroyDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
              >
                <span v-if="destroyDlg.busy">Destroying…</span>
                <span v-else>Destroy array</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

  </div>
</template>
