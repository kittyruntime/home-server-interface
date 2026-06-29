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

// ── State ─────────────────────────────────────────────────────────────────────

const loading = ref(true)
const error   = ref('')
const devices = ref<BlockDev[]>([])
const raids   = ref<RaidArray[]>([])

const physicalDisks = computed(() =>
  devices.value.filter(d => d.type === 'disk' || (d.type === 'md' && !raids.value.find(r => r.name === d.name)))
)

const raidBlockDevs = computed(() =>
  devices.value.filter(d => d.type === 'md' || raids.value.find(r => r.name === d.name))
)

// All non-system, unmounted, non-rom devices (disks AND partitions) for RAID selection
const eligibleForRaid = computed<BlockDev[]>(() => {
  const inRaid = new Set(raids.value.flatMap(r => r.devices))
  const out: BlockDev[] = []
  function collect(dev: BlockDev) {
    if (!dev.isSystem && !dev.mountpoint && !inRaid.has(dev.name) && dev.type !== 'rom' && dev.type !== 'loop') {
      out.push(dev)
    }
    dev.children?.forEach(collect)
  }
  devices.value.forEach(collect)
  return out
})

async function load() {
  loading.value = true
  error.value   = ''
  try {
    const res     = await trpc.system.blockDevices.query() as { devices: BlockDev[]; raids: RaidArray[] }
    devices.value = res.devices ?? []
    raids.value   = res.raids   ?? []
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
    await trpc.system.formatDisk.mutate({ device: w.dev.name, fstype: w.fstype, label: w.label || undefined })
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
    await trpc.system.mountDevice.mutate({ device: d.dev.name, mountpoint: d.mp, options: d.options || undefined, persist: d.persist })
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
    <div class="flex items-start justify-between mb-2">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Storage &amp; Disks</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Manage physical drives, RAID arrays, and mount points.</p>
      </div>
      <button
        @click="load"
        :disabled="loading"
        title="Refresh"
        class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
      >
        <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
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

    <template v-else>

      <!-- ── RAID Arrays ───────────────────────────────────────────────────── -->
      <section class="mt-6">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <svg class="w-3.5 h-3.5 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
            </svg>
            <h3 class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Software RAID</h3>
          </div>
          <button
            @click="openRaidWizard"
            class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            Create RAID
          </button>
        </div>

        <div v-if="raids.length === 0" class="rounded-xl border border-dashed border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-6 text-center text-sm text-[var(--c-text-3)]">
          No RAID arrays configured. Create one to combine multiple drives for redundancy or performance.
        </div>

        <div v-else class="space-y-4">
          <div
            v-for="r in raids"
            :key="r.name"
            class="rounded-xl border overflow-hidden bg-[var(--c-surface)]"
            :class="isRaidHealthy(r) ? 'border-[var(--c-border)]' : 'border-red-500/30'"
          >
            <!-- Header -->
            <div class="flex items-center gap-3 px-4 pt-4 pb-2">
              <span
                class="text-[11px] font-bold px-2.5 py-1 rounded-md tracking-wide"
                :class="isRaidHealthy(r) ? 'bg-[var(--c-accent)]/15 text-[var(--c-accent)]' : 'bg-red-500/10 text-red-400'"
              >{{ raidLevelLabel(r.level) }}</span>
              <span class="font-mono text-sm text-[var(--c-text-1)]">/dev/{{ r.name }}</span>
              <div class="ml-auto flex items-center gap-3">
                <span class="text-xs text-[var(--c-text-3)]">{{ r.active }}/{{ r.total }} drives</span>
                <span class="inline-flex items-center gap-1.5 text-xs font-medium" :class="isRaidHealthy(r) ? 'text-green-400' : 'text-red-400'">
                  <span class="w-1.5 h-1.5 rounded-full" :class="isRaidHealthy(r) ? 'bg-green-400' : 'bg-red-400'" />
                  {{ isRaidHealthy(r) ? 'Healthy' : r.state }}
                </span>
                <!-- Destroy -->
                <button
                  @click="openDestroy(r)"
                  title="Destroy array"
                  class="text-xs px-2 py-0.5 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                >Destroy</button>
              </div>
            </div>
            <p v-if="raidDescription(r.level)" class="text-[11px] text-[var(--c-text-3)] px-4 pb-3">{{ raidDescription(r.level) }}</p>

            <!-- Drive bay (reuse existing visualization) -->
            <div class="px-4 pb-4">
              <div class="flex items-center gap-1.5 flex-wrap">
                <template v-for="(dev, idx) in r.devices" :key="dev">
                  <div class="flex flex-col items-center gap-1.5">
                    <div class="relative rounded-lg border transition-colors"
                      :class="idx < r.active ? 'border-[var(--c-border-strong)] bg-[var(--c-surface-deep)]' : 'border-red-500/40 bg-red-500/5'"
                    >
                      <svg viewBox="0 0 52 68" class="w-12 h-16">
                        <rect x="3" y="3" width="46" height="62" rx="5"
                          :fill="idx < r.active ? 'var(--c-surface-deep)' : 'rgba(239,68,68,0.06)'"
                          :stroke="idx < r.active ? 'var(--c-border-strong)' : 'rgba(239,68,68,0.5)'"
                          stroke-width="1.5"
                        />
                        <circle cx="9"  cy="10" r="2" fill="var(--c-surface)" opacity="0.8"/>
                        <circle cx="43" cy="10" r="2" fill="var(--c-surface)" opacity="0.8"/>
                        <circle cx="9"  cy="58" r="2" fill="var(--c-surface)" opacity="0.8"/>
                        <circle cx="43" cy="58" r="2" fill="var(--c-surface)" opacity="0.8"/>
                        <circle cx="26" cy="32" r="12"
                          fill="none" :stroke="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.5)'"
                          stroke-width="1" opacity="0.35"
                        />
                        <circle cx="26" cy="32" r="6"
                          fill="none" :stroke="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.5)'"
                          stroke-width="1" opacity="0.35"
                        />
                        <line x1="26" y1="32" x2="35" y2="21"
                          :stroke="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.6)'"
                          stroke-width="1.5" opacity="0.5" stroke-linecap="round"
                        />
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
                <!-- Result -->
                <div class="flex items-center self-center mb-5 gap-2 ml-1">
                  <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                  </svg>
                  <div>
                    <div class="text-[11px] font-semibold text-[var(--c-text-2)]">{{ raidLevelLabel(r.level) }}</div>
                    <div class="text-[10px] text-[var(--c-text-3)] font-mono">
                      {{ raidBlockDev(r.name)?.mountpoint || 'not mounted' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Usage & mount actions (if the md device is in our lsblk tree) -->
            <template v-if="raidBlockDev(r.name)">
              <div class="border-t border-[var(--c-border)] px-4 py-3 flex items-center gap-3">
                <div class="flex-1">
                  <div v-if="raidBlockDev(r.name)!.mountpoint">
                    <div class="flex justify-between items-baseline mb-1.5">
                      <span class="text-[11px] font-mono text-[var(--c-text-3)]">{{ raidBlockDev(r.name)!.mountpoint }}</span>
                      <span class="text-[11px] text-[var(--c-text-3)]">{{ fmtBytes(raidBlockDev(r.name)!.usageUsed) }} / {{ fmtBytes(raidBlockDev(r.name)!.usageTotal) }}</span>
                    </div>
                    <div class="w-full h-1.5 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                      <div class="h-full rounded-full" :class="usageBarClass(usagePct(raidBlockDev(r.name)!))" :style="{ width: usagePct(raidBlockDev(r.name)!) + '%' }"/>
                    </div>
                    <div class="text-[10px] text-[var(--c-text-3)] mt-1">{{ fmtBytes(raidBlockDev(r.name)!.usageFree) }} free · {{ usagePct(raidBlockDev(r.name)!).toFixed(1) }}%</div>
                  </div>
                  <div v-else-if="raidBlockDev(r.name)!.fstype" class="text-[11px] text-[var(--c-text-3)]">
                    Formatted as <span class="font-mono">{{ raidBlockDev(r.name)!.fstype }}</span> — not mounted
                  </div>
                  <div v-else class="text-[11px] text-[var(--c-text-3)]">No filesystem — format before mounting</div>
                </div>
                <div class="flex gap-1.5 shrink-0">
                  <button v-if="!raidBlockDev(r.name)!.mountpoint && raidBlockDev(r.name)!.fstype" @click="openMount(raidBlockDev(r.name)!)"
                    class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                    Mount
                  </button>
                  <button v-if="raidBlockDev(r.name)!.mountpoint" @click="openUmount(raidBlockDev(r.name)!)"
                    class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-orange-500/50 hover:text-orange-400 transition-colors">
                    Unmount
                  </button>
                  <button v-if="!raidBlockDev(r.name)!.mountpoint" @click="openFormat(raidBlockDev(r.name)!)"
                    class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                    Format
                  </button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>

      <!-- ── Physical Drives ───────────────────────────────────────────────── -->
      <section class="mt-8">
        <div class="flex items-center gap-2 mb-3">
          <svg class="w-3.5 h-3.5 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0v-1.5m13.5 1.5v-1.5m0-10.5a3 3 0 00-3-3H9.75a3 3 0 00-3 3m9.75 0a3 3 0 01-3 3h-3a3 3 0 01-3-3m9.75 0H4.5m15 0h.008v.008H19.5v-.008z"/>
          </svg>
          <h3 class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Physical Drives</h3>
        </div>

        <div v-if="physicalDisks.length === 0" class="text-sm text-[var(--c-text-3)]">
          No block devices found.
        </div>

        <div class="space-y-4">
          <div
            v-for="disk in physicalDisks"
            :key="disk.name"
            class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] overflow-hidden"
          >
            <!-- Disk header -->
            <div class="flex items-center gap-3 px-4 py-3 bg-[var(--c-surface-deep)]/40">
              <div class="p-1.5 rounded-lg" :class="disk.isSystem ? 'bg-orange-500/10 text-orange-400' : 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0v-1.5m13.5 1.5v-1.5m0-10.5a3 3 0 00-3-3H9.75a3 3 0 00-3 3m9.75 0a3 3 0 01-3 3h-3a3 3 0 01-3-3m9.75 0H4.5m15 0h.008v.008H19.5v-.008z"/>
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-mono text-sm font-semibold text-[var(--c-text-1)]">/dev/{{ disk.name }}</span>
                  <span v-if="disk.model" class="text-xs text-[var(--c-text-3)] truncate">{{ disk.model }}</span>
                  <span class="text-xs text-[var(--c-text-3)]">{{ fmtBytes(disk.size) }}</span>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span v-if="disk.isSystem"
                  class="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20"
                >
                  <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                  </svg>
                  SYSTEM DISK
                </span>
                <span v-if="disk.isRemovable" class="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">REMOVABLE</span>
              </div>
            </div>

            <!-- System disk warning -->
            <div v-if="disk.isSystem" class="flex items-start gap-2 mx-4 mt-3 mb-1 px-3 py-2 rounded-lg bg-orange-500/5 border border-orange-500/15 text-xs text-orange-400">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              This disk is in use by the operating system. It cannot be formatted, partitioned, or added to a RAID array.
            </div>

            <!-- Partitions / children -->
            <div v-if="disk.children && disk.children.length > 0" class="divide-y divide-[var(--c-border)]">
              <div
                v-for="part in disk.children.filter(c => c.type !== 'swap')"
                :key="part.name"
                class="flex items-center gap-3 px-4 py-2.5"
              >
                <div class="w-1.5 h-1.5 rounded-full shrink-0" :class="part.isSystem ? 'bg-orange-400/60' : part.mountpoint ? 'bg-green-400/70' : 'bg-[var(--c-text-3)]/30'"/>

                <div class="flex-1 min-w-0 grid grid-cols-[1fr_auto] gap-x-4 items-start">
                  <!-- Left side: name, fstype, mountpoint, usage -->
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-mono text-xs text-[var(--c-text-2)]">/dev/{{ part.name }}</span>
                      <span class="text-[10px] text-[var(--c-text-3)]">{{ fmtBytes(part.size) }}</span>
                      <span v-if="part.fstype" class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--c-surface-deep)] text-[var(--c-text-3)] uppercase">{{ part.fstype }}</span>
                      <span v-else class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--c-surface-deep)] text-[var(--c-text-3)] italic">unformatted</span>
                    </div>
                    <div v-if="part.mountpoint" class="text-[10px] font-mono text-[var(--c-text-3)] mt-0.5">→ {{ part.mountpoint }}</div>

                    <!-- Usage bar if mounted -->
                    <div v-if="part.usageTotal > 0" class="mt-2 space-y-0.5">
                      <div class="w-full h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden max-w-xs">
                        <div class="h-full rounded-full" :class="usageBarClass(usagePct(part))" :style="{ width: usagePct(part) + '%' }"/>
                      </div>
                      <div class="text-[10px] text-[var(--c-text-3)]">{{ fmtBytes(part.usageFree) }} free · {{ usagePct(part).toFixed(1) }}%</div>
                    </div>
                  </div>

                  <!-- Actions -->
                  <div v-if="!part.isSystem" class="flex items-center gap-1 shrink-0">
                    <button v-if="!part.mountpoint" @click="openFormat(part)"
                      class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                      Format
                    </button>
                    <button v-if="part.fstype && !part.mountpoint" @click="openMount(part)"
                      class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-green-500/50 hover:text-green-400 transition-colors">
                      Mount
                    </button>
                    <button v-if="part.mountpoint" @click="openUmount(part)"
                      class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-orange-500/50 hover:text-orange-400 transition-colors">
                      Unmount
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Unpartitioned disk (no children) -->
            <div v-else-if="!disk.isSystem" class="flex items-center gap-3 px-4 py-2.5">
              <div class="w-1.5 h-1.5 rounded-full shrink-0" :class="disk.fstype ? 'bg-[var(--c-accent)]/60' : 'bg-[var(--c-text-3)]/30'"/>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span v-if="disk.fstype" class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--c-surface-deep)] text-[var(--c-text-3)] uppercase">{{ disk.fstype }}</span>
                  <span v-else class="text-xs italic text-[var(--c-text-3)]">No partitions — raw disk</span>
                </div>
                <div v-if="disk.mountpoint" class="text-[10px] font-mono text-[var(--c-text-3)] mt-0.5">→ {{ disk.mountpoint }}</div>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button v-if="!disk.mountpoint" @click="openFormat(disk)"
                  class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                  Format
                </button>
                <button v-if="disk.fstype && !disk.mountpoint" @click="openMount(disk)"
                  class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-green-500/50 hover:text-green-400 transition-colors">
                  Mount
                </button>
                <button v-if="disk.mountpoint" @click="openUmount(disk)"
                  class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-orange-500/50 hover:text-orange-400 transition-colors">
                  Unmount
                </button>
              </div>
            </div>

            <!-- No partitions, is system -->
            <div v-else-if="disk.isSystem && !disk.children?.length" class="px-4 py-2.5 text-[11px] text-[var(--c-text-3)] italic">
              System disk — no actions available
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
              <span class="text-xs">Drives must be unmounted, unformatted, and not part of the OS.</span>
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
