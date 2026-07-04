<script setup lang="ts">
import { ref, computed } from 'vue'
import { trpc } from '../../lib/trpc'
import {
  useStorageData, fmtBytes, fmtHours, fmtTiB, usagePct, usageBarClass,
  type BlockDev,
} from '../../composables/useStorageData'
import LoadingSpinner from '../ui/LoadingSpinner.vue'

const emit = defineEmits<{ navigate: [section: 'raid' | 'lvm'] }>()

const { loading, error, devices, raids, lvmPVs, refresh } = useStorageData()

// ── Types (SMART) ─────────────────────────────────────────────────────────────

type SmartAttr = {
  id: number; name: string; value: number; worst: number; thresh: number
  raw: number; failed: boolean; isCritical: boolean
}
type NvmeInfo = {
  criticalWarning: number; temperature: number
  availableSpare: number; availableSpareThresh: number; percentageUsed: number
  dataReadTiB: number; dataWrittenTiB: number; mediaErrors: number; errorLogEntries: number
}
type SmartResult = {
  device: string; available: boolean
  modelFamily?: string; modelName?: string; serialNumber?: string; firmware?: string
  rotationRate: number; healthPassed: boolean; temperature: number
  powerOnHours: number; powerCycles: number
  attributes: SmartAttr[]; nvme?: NvmeInfo
  _loading?: boolean; _error?: string
}

// ── State (SMART) ─────────────────────────────────────────────────────────────

const smartCache = ref<Record<string, SmartResult>>({})
const smartOpen  = ref<Set<string>>(new Set())

function toggleSmart(diskName: string) {
  const s = new Set(smartOpen.value)
  if (s.has(diskName)) { s.delete(diskName) } else {
    s.add(diskName)
    if (!smartCache.value[diskName] || smartCache.value[diskName]._error) fetchSmart(diskName)
  }
  smartOpen.value = s
}

async function fetchSmart(diskName: string) {
  smartCache.value = {
    ...smartCache.value,
    [diskName]: { device: diskName, available: false, rotationRate: 0, healthPassed: false, temperature: 0, powerOnHours: 0, powerCycles: 0, attributes: [], _loading: true },
  }
  try {
    const res = await trpc.system.smartInfo.query({ device: diskName }) as SmartResult
    smartCache.value = { ...smartCache.value, [diskName]: res }
  } catch (e: unknown) {
    smartCache.value = {
      ...smartCache.value,
      [diskName]: { device: diskName, available: false, rotationRate: 0, healthPassed: false, temperature: 0, powerOnHours: 0, powerCycles: 0, attributes: [], _error: (e as { message?: string })?.message ?? 'SMART query failed' },
    }
  }
}

function smartStatus(diskName: string): 'unknown' | 'loading' | 'passed' | 'warning' | 'failed' {
  const s = smartCache.value[diskName]
  if (!s) return 'unknown'
  if (s._loading) return 'loading'
  if (!s.available) return 'unknown'
  if (!s.healthPassed) return 'failed'
  if (s.attributes.some(a => a.isCritical && a.raw > 0)) return 'warning'
  if (s.nvme && (s.nvme.criticalWarning > 0 || s.nvme.mediaErrors > 0)) return 'warning'
  return 'passed'
}

// ── Computed ──────────────────────────────────────────────────────────────────

const physicalDisks = computed(() => devices.value.filter(d => d.type === 'disk'))

// Helper: is this disk a member of any RAID array?
function diskRaidName(diskName: string): string | undefined {
  return raids.value.find(r =>
    r.devices.some(d => d === diskName || d.startsWith(diskName))
  )?.name
}

// Helper: is this disk (or any of its partitions) used as an LVM PV?
function diskPvVg(diskName: string): string | undefined {
  return lvmPVs.value.find(p => {
    const pvDev = p.name.replace('/dev/', '')
    return pvDev === diskName || pvDev.replace(/p?\d+$/, '') === diskName
  })?.vgName
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

// ── Partition dialogs ─────────────────────────────────────────────────────────

const partInitDlg = ref<{ disk: BlockDev; confirm: string; busy: boolean; err: string } | null>(null)

async function doPartInit() {
  if (!partInitDlg.value || partInitDlg.value.confirm !== partInitDlg.value.disk.name) return
  const d = partInitDlg.value
  d.busy = true; d.err = ''
  try {
    await trpc.system.initPartitionTable.mutate({ device: d.disk.name })
    partInitDlg.value = null
    await refresh()
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? 'Failed to initialise partition table'
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
    await refresh()
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? 'Failed to create partition'
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
    await refresh()
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? 'Failed to delete partition'
  } finally {
    if (partDeleteDlg.value) d.busy = false
  }
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
    const device = w.dev.path.replace(/^\/dev\//, '')
    await trpc.system.formatDisk.mutate({ device, fstype: w.fstype, label: w.label || undefined })
    formatWiz.value = null
    await refresh()
  } catch (e: unknown) {
    w.err = (e as { message?: string })?.message ?? 'Format failed'
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
    await refresh()
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? 'Mount failed'
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
    await refresh()
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? 'Unmount failed'
  } finally {
    if (umountDlg.value) d.busy = false
  }
}
</script>

<template>
  <div>
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Physical disks</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Disks, partitions, and S.M.A.R.T. health.</p>
      </div>
      <button @click="refresh" :disabled="loading" title="Refresh" class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
        <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
    </div>

    <div v-if="loading && !devices.length" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6">
      <LoadingSpinner /> Loading…
    </div>
    <div v-else-if="error" class="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{{ error }}</div>

    <div v-if="openMenu" class="fixed inset-0 z-20" @click="openMenu = null"/>

    <template v-if="!loading || devices.length">

      <!-- ════════════════════════════════════════════════════════════════════ -->
      <!-- DISK CARDS                                                           -->
      <!-- ════════════════════════════════════════════════════════════════════ -->
      <section>
        <div v-if="physicalDisks.length === 0" class="text-sm text-[var(--c-text-3)]">No physical drives detected.</div>

        <div class="space-y-3">
          <div v-for="disk in physicalDisks" :key="disk.name"
            class="rounded-xl border bg-[var(--c-surface)] overflow-hidden flex"
            :class="disk.isSystem ? 'border-warning/20' : 'border-[var(--c-border)]'">
            <!-- Left stripe by type -->
            <div class="w-0.5 shrink-0"
              :class="disk.isSystem ? 'bg-warning/60' : disk.isRemovable ? 'bg-info/50' : 'bg-[var(--c-border-strong)]'"/>
            <div class="flex-1 min-w-0">

              <!-- Disk header -->
              <div class="flex items-center gap-3 px-4 py-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-mono text-sm font-semibold text-[var(--c-text-1)]">/dev/{{ disk.name }}</span>
                    <span v-if="disk.model" class="text-[11px] text-[var(--c-text-3)] truncate">{{ disk.model }}</span>
                    <span class="text-[11px] text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(disk.size) }}</span>
                    <span v-if="disk.isSystem" class="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-warning/10 text-warning border border-warning/20">
                      <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                      SYSTEM
                    </span>
                    <span v-if="disk.isRemovable" class="text-[10px] px-1.5 py-0.5 rounded-sm bg-info/10 text-info border border-info/20">USB</span>
                    <!-- Cross-nav: RAID membership badge -->
                    <button v-if="diskRaidName(disk.name)" @click="emit('navigate', 'raid')"
                      class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm bg-info/10 text-info border border-info/20 hover:bg-info/20 transition-colors">
                      RAID {{ diskRaidName(disk.name) }} →
                    </button>
                    <!-- Cross-nav: LVM PV badge -->
                    <button v-if="diskPvVg(disk.name)" @click="emit('navigate', 'lvm')"
                      class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors">
                      LVM {{ diskPvVg(disk.name) }} →
                    </button>
                  </div>
                  <div v-if="disk.isSystem" class="text-[10px] text-warning/70 mt-0.5">Operating system disk — no modifications allowed</div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <!-- Health badge -->
                  <button @click="toggleSmart(disk.name)" title="S.M.A.R.T. health"
                    :class="['inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-lg border transition-colors',
                      smartStatus(disk.name) === 'passed'  ? 'bg-success/10 border-success/25 text-success hover:bg-success/20' :
                      smartStatus(disk.name) === 'warning' ? 'bg-warning/10 border-warning/25 text-warning hover:bg-warning/20' :
                      smartStatus(disk.name) === 'failed'  ? 'bg-danger/10 border-danger/25 text-danger hover:bg-danger/20' :
                      smartStatus(disk.name) === 'loading' ? 'bg-[var(--c-surface-deep)] border-[var(--c-border)] text-[var(--c-text-3)]' :
                      'bg-[var(--c-surface-deep)] border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-border-strong)] hover:text-[var(--c-text-2)]']">
                    <!-- Spinner when loading -->
                    <svg v-if="smartStatus(disk.name) === 'loading'" class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                    </svg>
                    <!-- Status dot otherwise -->
                    <span v-else class="w-1.5 h-1.5 rounded-full"
                      :class="smartStatus(disk.name) === 'passed' ? 'bg-success' : smartStatus(disk.name) === 'warning' ? 'bg-warning' : smartStatus(disk.name) === 'failed' ? 'bg-danger animate-pulse' : 'bg-[var(--c-text-3)]/40'"/>
                    <span v-if="smartStatus(disk.name) === 'passed'">Healthy</span>
                    <span v-else-if="smartStatus(disk.name) === 'warning'">Warning</span>
                    <span v-else-if="smartStatus(disk.name) === 'failed'">Failed</span>
                    <span v-else-if="smartStatus(disk.name) === 'loading'">…</span>
                    <span v-else>SMART</span>
                    <!-- Temperature (when data loaded) -->
                    <template v-if="smartCache[disk.name]?.available && smartCache[disk.name]?.temperature">
                      <span class="opacity-50">·</span>
                      <span :class="(smartCache[disk.name]?.temperature ?? 0) >= 55 ? 'text-danger' : (smartCache[disk.name]?.temperature ?? 0) >= 40 ? 'text-warning' : ''">{{ smartCache[disk.name]?.temperature }}°C</span>
                    </template>
                  </button>
                  <!-- + Partition button (non-system only) -->
                  <button v-if="!disk.isSystem" @click="partCreateDlg = { disk, busy: false, err: '' }"
                    class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                    + Partition
                  </button>
                </div>
              </div>

              <!-- SMART health panel (expandable) -->
              <div v-if="smartOpen.has(disk.name)" class="border-t border-[var(--c-border)] bg-[var(--c-surface-deep)]/40">
                <!-- sc = SmartResult | undefined, scoped for TS narrowing -->
                <template v-for="sc in [smartCache[disk.name]]" :key="disk.name">
                  <!-- Loading -->
                  <div v-if="sc?._loading" class="flex items-center gap-2 px-4 py-4 text-sm text-[var(--c-text-3)]">
                    <svg class="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                    </svg>
                    Reading S.M.A.R.T. data…
                  </div>

                  <!-- Error -->
                  <div v-else-if="sc?._error" class="px-4 py-3 text-sm text-danger">
                    {{ sc._error }}
                  </div>

                  <!-- Unavailable -->
                  <div v-else-if="sc && !sc.available" class="px-4 py-3 text-sm text-[var(--c-text-3)] italic">
                    S.M.A.R.T. not available for this device (smartctl may not be installed or the device may not support it).
                  </div>

                  <!-- Data -->
                  <template v-else-if="sc?.available">
                    <!-- Overview row -->
                    <div class="px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--c-border)]">
                      <!-- Health -->
                      <div class="flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full shrink-0"
                          :class="smartStatus(disk.name) === 'passed' ? 'bg-success' : smartStatus(disk.name) === 'warning' ? 'bg-warning' : 'bg-danger'"/>
                        <span class="text-xs font-semibold"
                          :class="smartStatus(disk.name) === 'passed' ? 'text-success' : smartStatus(disk.name) === 'warning' ? 'text-warning' : 'text-danger'">
                          {{ sc.healthPassed ? 'PASSED' : 'FAILED' }}
                        </span>
                      </div>
                      <!-- Temperature -->
                      <div v-if="sc.temperature" class="flex items-center gap-1 text-xs">
                        <svg class="w-3 h-3 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/>
                        </svg>
                        <span :class="sc.temperature >= 55 ? 'text-danger font-semibold' : sc.temperature >= 40 ? 'text-warning' : 'text-[var(--c-text-2)]'">
                          {{ sc.temperature }}°C
                        </span>
                      </div>
                      <!-- Power-on hours -->
                      <div v-if="sc.powerOnHours" class="flex items-center gap-1 text-xs text-[var(--c-text-3)]">
                        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        {{ fmtHours(sc.powerOnHours) }} powered on
                      </div>
                      <!-- Power cycles -->
                      <div v-if="sc.powerCycles" class="text-xs text-[var(--c-text-3)]">
                        {{ sc.powerCycles.toLocaleString() }} power cycles
                      </div>
                      <!-- Drive type -->
                      <div class="ml-auto text-[10px] px-1.5 py-0.5 rounded-sm bg-[var(--c-surface-deep)] border border-[var(--c-border)] text-[var(--c-text-3)]">
                        {{ sc.nvme ? 'NVMe' : sc.rotationRate === 0 ? 'SSD' : `HDD ${sc.rotationRate} RPM` }}
                      </div>
                    </div>

                    <!-- Device info row -->
                    <div v-if="sc.serialNumber || sc.firmware" class="px-4 py-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--c-text-3)] border-b border-[var(--c-border)]">
                      <span v-if="sc.modelFamily"><span class="text-[var(--c-text-2)]">Family</span> {{ sc.modelFamily }}</span>
                      <span v-if="sc.serialNumber"><span class="text-[var(--c-text-2)]">S/N</span> <span class="font-mono">{{ sc.serialNumber }}</span></span>
                      <span v-if="sc.firmware"><span class="text-[var(--c-text-2)]">FW</span> <span class="font-mono">{{ sc.firmware }}</span></span>
                    </div>

                    <!-- NVMe health log -->
                    <div v-if="sc.nvme" class="px-4 py-3 space-y-2">
                      <div class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] mb-2">NVMe Health Log</div>
                      <div class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                        <div class="flex justify-between gap-2">
                          <span class="text-[var(--c-text-3)]">Critical Warning</span>
                          <span :class="sc.nvme.criticalWarning > 0 ? 'text-danger font-semibold' : 'text-[var(--c-text-2)]'">{{ sc.nvme.criticalWarning }}</span>
                        </div>
                        <div class="flex justify-between gap-2">
                          <span class="text-[var(--c-text-3)]">Media Errors</span>
                          <span :class="sc.nvme.mediaErrors > 0 ? 'text-danger font-semibold' : 'text-[var(--c-text-2)]'">{{ sc.nvme.mediaErrors }}</span>
                        </div>
                        <div class="flex justify-between gap-2">
                          <span class="text-[var(--c-text-3)]">Available Spare</span>
                          <span :class="sc.nvme.availableSpare <= sc.nvme.availableSpareThresh ? 'text-danger font-semibold' : 'text-[var(--c-text-2)]'">{{ sc.nvme.availableSpare }}% <span class="text-[var(--c-text-3)]">(min {{ sc.nvme.availableSpareThresh }}%)</span></span>
                        </div>
                        <div class="flex justify-between gap-2">
                          <span class="text-[var(--c-text-3)]">Percentage Used</span>
                          <span :class="sc.nvme.percentageUsed >= 90 ? 'text-danger font-semibold' : sc.nvme.percentageUsed >= 70 ? 'text-warning' : 'text-[var(--c-text-2)]'">{{ sc.nvme.percentageUsed }}%</span>
                        </div>
                        <div v-if="sc.nvme.dataReadTiB > 0" class="flex justify-between gap-2">
                          <span class="text-[var(--c-text-3)]">Data Read</span>
                          <span class="text-[var(--c-text-2)] font-mono">{{ fmtTiB(sc.nvme.dataReadTiB) }}</span>
                        </div>
                        <div v-if="sc.nvme.dataWrittenTiB > 0" class="flex justify-between gap-2">
                          <span class="text-[var(--c-text-3)]">Data Written</span>
                          <span class="text-[var(--c-text-2)] font-mono">{{ fmtTiB(sc.nvme.dataWrittenTiB) }}</span>
                        </div>
                      </div>
                    </div>

                    <!-- ATA attributes table -->
                    <div v-if="sc.attributes.length > 0" class="px-4 pb-4 pt-3">
                      <div class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] mb-2">ATA Attributes</div>
                      <div class="rounded-lg overflow-hidden border border-[var(--c-border)]">
                        <table class="w-full text-[11px] border-collapse">
                          <thead>
                            <tr class="bg-[var(--c-surface-deep)] text-[var(--c-text-3)]">
                              <th class="text-left px-2.5 py-1.5 font-medium w-8">ID</th>
                              <th class="text-left px-2.5 py-1.5 font-medium">Attribute</th>
                              <th class="text-right px-2.5 py-1.5 font-medium tabular-nums">Value</th>
                              <th class="text-right px-2.5 py-1.5 font-medium tabular-nums">Worst</th>
                              <th class="text-right px-2.5 py-1.5 font-medium tabular-nums">Thresh</th>
                              <th class="text-right px-2.5 py-1.5 font-medium tabular-nums">Raw</th>
                              <th class="text-center px-2.5 py-1.5 font-medium w-8"></th>
                            </tr>
                          </thead>
                          <tbody class="divide-y divide-[var(--c-border)]">
                            <tr v-for="attr in sc.attributes" :key="attr.id"
                              :class="['transition-colors', attr.failed ? 'bg-danger/8' : attr.isCritical && attr.raw > 0 ? 'bg-warning/6' : '']">
                              <td class="px-2.5 py-1.5 font-mono text-[var(--c-text-3)]">{{ attr.id }}</td>
                              <td class="px-2.5 py-1.5 font-mono"
                                :class="attr.failed ? 'text-danger font-semibold' : attr.isCritical ? 'text-[var(--c-text-1)]' : 'text-[var(--c-text-2)]'">
                                {{ attr.name.replace(/_/g, ' ') }}
                              </td>
                              <td class="px-2.5 py-1.5 tabular-nums text-right text-[var(--c-text-2)]">{{ attr.value }}</td>
                              <td class="px-2.5 py-1.5 tabular-nums text-right text-[var(--c-text-3)]">{{ attr.worst }}</td>
                              <td class="px-2.5 py-1.5 tabular-nums text-right text-[var(--c-text-3)]">{{ attr.thresh }}</td>
                              <td class="px-2.5 py-1.5 tabular-nums text-right font-mono"
                                :class="attr.failed ? 'text-danger font-semibold' : attr.isCritical && attr.raw > 0 ? 'text-warning font-semibold' : 'text-[var(--c-text-2)]'">
                                {{ attr.raw.toLocaleString() }}
                              </td>
                              <td class="px-2.5 py-1.5 text-center">
                                <svg v-if="attr.failed" class="w-3 h-3 text-danger mx-auto" fill="currentColor" viewBox="0 0 20 20">
                                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
                                </svg>
                                <svg v-else-if="attr.isCritical && attr.raw > 0" class="w-3 h-3 text-warning mx-auto" fill="currentColor" viewBox="0 0 20 20">
                                  <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
                                </svg>
                                <svg v-else-if="attr.isCritical" class="w-3 h-3 text-success/60 mx-auto" fill="currentColor" viewBox="0 0 20 20">
                                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
                                </svg>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </template>
                </template>
              </div>

              <!-- Partitions -->
              <div v-if="disk.children && disk.children.length > 0" class="border-t border-[var(--c-border)] divide-y divide-[var(--c-border)]">
                <div v-for="part in disk.children.filter(c => c.type !== 'swap')" :key="part.name"
                  class="group/part flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--c-hover)]/30 transition-colors">
                  <!-- Status dot -->
                  <div class="w-1.5 h-1.5 rounded-full shrink-0"
                    :class="part.isSystem ? 'bg-warning/60' : part.mountpoint ? 'bg-success/70' : 'bg-[var(--c-text-3)]/25'"/>
                  <!-- Info -->
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="font-mono text-xs text-[var(--c-text-2)]">/dev/{{ part.name }}</span>
                      <span class="text-[10px] text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(part.size) }}</span>
                      <span v-if="part.fstype" class="text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-[var(--c-surface-deep)] text-[var(--c-text-3)] uppercase border border-[var(--c-border)]">{{ part.fstype }}</span>
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
                      class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">Format</button>
                    <button v-if="part.fstype && !part.mountpoint" @click="openMount(part)"
                      class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-success/50 hover:text-success transition-colors">Mount</button>
                    <button v-if="part.mountpoint" @click="openUmount(part)"
                      class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-warning/50 hover:text-warning transition-colors">Unmount</button>
                    <div class="w-px h-3 bg-[var(--c-border)] mx-1"/>
                    <button v-if="!part.mountpoint" @click="partDeleteDlg = { disk, part, busy: false, err: '' }"
                      title="Delete this partition"
                      class="w-6 h-6 flex items-center justify-center rounded-sm text-[var(--c-text-3)]/40 hover:text-danger hover:bg-danger/10 transition-colors">
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              <!-- Unpartitioned raw disk -->
              <div v-else-if="!disk.isSystem" class="border-t border-[var(--c-border)]">
                <!-- Has a filesystem directly on the raw disk -->
                <div v-if="disk.fstype" class="flex items-center gap-3 px-4 py-2.5">
                  <div class="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--c-accent)]/60"/>
                  <div class="flex-1 min-w-0">
                    <span class="text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-[var(--c-surface-deep)] text-[var(--c-text-3)] uppercase border border-[var(--c-border)]">{{ disk.fstype }}</span>
                    <div v-if="disk.mountpoint" class="text-[10px] font-mono text-[var(--c-text-3)] mt-0.5">↳ {{ disk.mountpoint }}</div>
                  </div>
                  <div class="flex items-center gap-1 shrink-0">
                    <button v-if="!disk.mountpoint" @click="openFormat(disk)"
                      class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">Format</button>
                    <button v-if="!disk.mountpoint" @click="openMount(disk)"
                      class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-success/50 hover:text-success transition-colors">Mount</button>
                    <button v-if="disk.mountpoint" @click="openUmount(disk)"
                      class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-warning/50 hover:text-warning transition-colors">Unmount</button>
                  </div>
                </div>
                <!-- Truly blank disk — no partition table, no filesystem -->
                <div v-else class="flex items-center gap-3 px-4 py-2.5">
                  <div class="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--c-text-3)]/20"/>
                  <div class="flex-1 min-w-0">
                    <span class="text-[11px] text-[var(--c-text-3)]">No partition table — create one to start using this disk.</span>
                  </div>
                  <button @click="partInitDlg = { disk, confirm: '', busy: false, err: '' }"
                    class="shrink-0 text-[11px] px-2.5 py-1 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                    Create partition table…
                  </button>
                </div>
              </div>

              <!-- Expandable danger zone — only for disks that already have partitions -->
              <div v-if="!disk.isSystem && disk.children && disk.children.length > 0" class="border-t border-[var(--c-border)]">
                <button @click="toggleDanger(disk.name)"
                  class="w-full flex items-center gap-2 px-4 py-2 text-[10px] text-[var(--c-text-3)]/60 hover:text-[var(--c-text-3)] transition-colors">
                  <svg class="w-3 h-3 shrink-0 transition-transform" :class="dangerDisks.has(disk.name) ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                  </svg>
                  Advanced
                </button>
                <div v-if="dangerDisks.has(disk.name)" class="px-4 pb-3 pt-0.5">
                  <div class="flex items-start gap-3 p-3 rounded-lg border border-danger/20 bg-danger/5">
                    <svg class="w-3.5 h-3.5 text-danger/70 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                    </svg>
                    <div class="flex-1 min-w-0">
                      <p class="text-[11px] text-[var(--c-text-2)] font-medium mb-0.5">Wipe and create a new partition table</p>
                      <p class="text-[10px] text-[var(--c-text-3)]">Permanently destroys all existing partitions and data on <span class="font-mono">/dev/{{ disk.name }}</span>. Cannot be undone.</p>
                      <button @click="partInitDlg = { disk, confirm: '', busy: false, err: '' }"
                        class="mt-2 text-[11px] px-2.5 py-1 rounded-sm border border-danger/30 text-danger/80 hover:border-danger/60 hover:text-danger hover:bg-danger/10 transition-colors">
                        Create partition table…
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
        <div class="w-full max-w-md bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl shadow-[var(--shadow-md)] overflow-hidden">

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
            <div class="flex items-start gap-3 p-4 rounded-xl bg-danger/10 border border-danger/30">
              <svg class="w-5 h-5 text-danger mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <div>
                <div class="font-semibold text-danger text-sm mb-1">All data will be permanently erased</div>
                <div class="text-xs text-danger/80">
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
                    <span class="text-[10px] px-1.5 py-0.5 rounded-[var(--radius-sm)]"
                      :class="fs.tag === 'Recommended' ? 'bg-success/15 text-success' : 'bg-[var(--c-surface-deep)] text-[var(--c-text-3)]'"
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
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-danger transition-colors"
              />
            </div>

            <div v-if="formatWiz.err" class="text-xs text-danger px-1">{{ formatWiz.err }}</div>

            <div class="flex gap-2">
              <button @click="formatWiz.step = 2" :disabled="formatWiz.busy" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors disabled:opacity-50">← Back</button>
              <button
                @click="doFormat"
                :disabled="formatWiz.confirm !== formatWiz.dev.name || formatWiz.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/85 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
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
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl shadow-[var(--shadow-md)] overflow-hidden">
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
            <div v-if="mountDlg.err" class="text-xs text-danger">{{ mountDlg.err }}</div>
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
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl shadow-[var(--shadow-md)] overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)]">
            <h3 class="font-semibold text-[var(--c-text-1)]">Unmount device</h3>
          </div>
          <div class="p-5 space-y-4">
            <div class="p-3 rounded-lg bg-warning/5 border border-warning/15 text-xs text-warning">
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
            <div v-if="umountDlg.err" class="text-xs text-danger">{{ umountDlg.err }}</div>
            <div class="flex gap-2 pt-1">
              <button @click="umountDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doUmount" :disabled="umountDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-warning text-white hover:bg-warning/85 transition-colors disabled:opacity-40 font-medium">
                <span v-if="umountDlg.busy">Unmounting…</span>
                <span v-else>Unmount</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- CREATE PARTITION TABLE DIALOG                                          -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="partInitDlg" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" @click.self="!partInitDlg.busy && (partInitDlg = null)">
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-danger/30 rounded-xl shadow-[var(--shadow-md)] overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)] bg-danger/5">
            <h3 class="font-semibold text-danger">Create partition table</h3>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">Writes a new GPT partition table — all existing data on the disk will be lost.</p>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-start gap-2 p-3 rounded-lg bg-danger/10 border border-danger/20 text-xs text-danger">
              <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <span>All partitions and data on <span class="font-mono font-bold">/dev/{{ partInitDlg.disk.name }}</span> will be permanently destroyed. This cannot be undone.</span>
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
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-danger transition-colors"/>
            </div>
            <div v-if="partInitDlg.err" class="text-xs text-danger">{{ partInitDlg.err }}</div>
            <div class="flex gap-2">
              <button @click="partInitDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doPartInit" :disabled="partInitDlg.confirm !== partInitDlg.disk.name || partInitDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/85 transition-colors disabled:opacity-40 font-medium">
                <span v-if="partInitDlg.busy">Creating…</span>
                <span v-else>Create partition table</span>
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
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl shadow-[var(--shadow-md)] overflow-hidden">
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
            <div v-if="partCreateDlg.err" class="text-xs text-danger">{{ partCreateDlg.err }}</div>
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
        <div class="w-full max-w-sm bg-[var(--c-surface)] border border-danger/30 rounded-xl shadow-[var(--shadow-md)] overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--c-border)] bg-danger/5">
            <h3 class="font-semibold text-danger">Delete partition</h3>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-start gap-2 p-3 rounded-lg bg-danger/10 border border-danger/20 text-xs text-danger">
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
            <div v-if="partDeleteDlg.err" class="text-xs text-danger">{{ partDeleteDlg.err }}</div>
            <div class="flex gap-2">
              <button @click="partDeleteDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button @click="doPartDelete" :disabled="partDeleteDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/85 transition-colors disabled:opacity-40 font-medium">
                <span v-if="partDeleteDlg.busy">Deleting…</span>
                <span v-else>Delete partition</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

  </div>
</template>
