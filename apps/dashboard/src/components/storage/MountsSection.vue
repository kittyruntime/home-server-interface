<script setup lang="ts">
import { ref, computed } from 'vue'
import { trpc } from '../../lib/trpc'
import { useStorageData, fmtBytes, usagePct, usageBarClass, lvToBlockDev, raidLevelLabel, type BlockDev } from '../../composables/useStorageData'
import LoadingSpinner from '../ui/LoadingSpinner.vue'

const emit = defineEmits<{ navigate: [section: 'disks' | 'raid' | 'lvm'] }>()

const { loading, error, devices, raids, lvmLVs, refresh } = useStorageData()

// ── Aggregated mount data ─────────────────────────────────────────────────────

type MountSource = 'disk' | 'raid' | 'lvm'

type MountEntry = {
  key:        string
  device:     string      // /dev/sdb1
  mountpoint: string
  fstype:     string
  source:     MountSource
  sourceLabel: string     // "RAID 1" | "LVM vg0/lv0" | "sdb"
  usageTotal: number
  usageUsed:  number
  usageFree:  number
  bd:         BlockDev
}

type UnmountedEntry = {
  key:         string
  device:      string
  fstype:      string
  source:      MountSource
  sourceLabel: string
  size:        number
  bd:          BlockDev
}

function allBlockDevFlat(): BlockDev[] {
  const out: BlockDev[] = []
  function walk(d: BlockDev) { out.push(d); d.children?.forEach(walk) }
  devices.value.forEach(walk)
  return out
}

const mounted = computed<MountEntry[]>(() => {
  const entries: MountEntry[] = []
  const raidNames = new Set(raids.value.map(r => r.name))

  // Physical disk partitions/raw disks that are mounted
  for (const bd of allBlockDevFlat()) {
    if (!bd.mountpoint) continue
    if (raidNames.has(bd.name)) continue              // RAID md device handled separately
    if (bd.type === 'dm' || bd.type === 'lvm') continue  // LVM DM handled via lvmLVs
    if (bd.fstype === 'swap') continue                // skip swap
    const parentDisk = devices.value.find(d => bd.name.startsWith(d.name) && d.type === 'disk')
    entries.push({
      key:         `disk:${bd.name}`,
      device:      `/dev/${bd.name}`,
      mountpoint:  bd.mountpoint,
      fstype:      bd.fstype,
      source:      'disk',
      sourceLabel: parentDisk?.name ?? bd.name,
      usageTotal:  bd.usageTotal,
      usageUsed:   bd.usageUsed,
      usageFree:   bd.usageFree,
      bd,
    })
  }

  // RAID arrays that are mounted
  for (const r of raids.value) {
    const bd = allBlockDevFlat().find(d => d.name === r.name)
    if (!bd?.mountpoint) continue
    entries.push({
      key:         `raid:${r.name}`,
      device:      `/dev/${r.name}`,
      mountpoint:  bd.mountpoint,
      fstype:      bd.fstype,
      source:      'raid',
      sourceLabel: raidLevelLabel(r.level),
      usageTotal:  bd.usageTotal,
      usageUsed:   bd.usageUsed,
      usageFree:   bd.usageFree,
      bd,
    })
  }

  // LVM logical volumes that are mounted
  for (const lv of lvmLVs.value) {
    const bd = lvToBlockDev(lv, devices.value)
    if (!bd.mountpoint) continue
    entries.push({
      key:         `lvm:${lv.path}`,
      device:      lv.path,
      mountpoint:  bd.mountpoint,
      fstype:      bd.fstype,
      source:      'lvm',
      sourceLabel: `${lv.vgName}/${lv.name}`,
      usageTotal:  bd.usageTotal,
      usageUsed:   bd.usageUsed,
      usageFree:   bd.usageFree,
      bd,
    })
  }

  return entries.sort((a, b) => a.mountpoint.localeCompare(b.mountpoint))
})

const unmounted = computed<UnmountedEntry[]>(() => {
  const entries: UnmountedEntry[] = []
  const raidNames = new Set(raids.value.map(r => r.name))

  for (const bd of allBlockDevFlat()) {
    if (bd.mountpoint || !bd.fstype) continue
    if (raidNames.has(bd.name)) continue
    if (bd.type === 'dm' || bd.type === 'lvm' || bd.isSystem) continue
    if (bd.fstype === 'swap') continue
    const parentDisk = devices.value.find(d => bd.name.startsWith(d.name) && d.type === 'disk')
    entries.push({
      key:         `disk:${bd.name}`,
      device:      `/dev/${bd.name}`,
      fstype:      bd.fstype,
      source:      'disk',
      sourceLabel: parentDisk?.name ?? bd.name,
      size:        bd.size,
      bd,
    })
  }

  for (const r of raids.value) {
    const bd = allBlockDevFlat().find(d => d.name === r.name)
    if (!bd || bd.mountpoint || !bd.fstype) continue
    entries.push({
      key:         `raid:${r.name}`,
      device:      `/dev/${r.name}`,
      fstype:      bd.fstype,
      source:      'raid',
      sourceLabel: raidLevelLabel(r.level),
      size:        bd.size,
      bd,
    })
  }

  for (const lv of lvmLVs.value) {
    const bd = lvToBlockDev(lv, devices.value)
    if (bd.mountpoint || !bd.fstype || bd.isSystem) continue
    entries.push({
      key:         `lvm:${lv.path}`,
      device:      lv.path,
      fstype:      bd.fstype,
      source:      'lvm',
      sourceLabel: `${lv.vgName}/${lv.name}`,
      size:        lv.size,
      bd,
    })
  }

  return entries
})

const sourceNavTarget: Record<MountSource, 'disks' | 'raid' | 'lvm'> = {
  disk: 'disks',
  raid: 'raid',
  lvm:  'lvm',
}

const sourceBadgeClass: Record<MountSource, string> = {
  disk:  'bg-[var(--c-surface-deep)] text-[var(--c-text-3)] border-[var(--c-border)] hover:border-[var(--c-border-strong)]',
  raid:  'bg-info/10 text-info border-info/20 hover:bg-info/20',
  lvm:   'bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20',
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
    <div class="flex items-start justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Mounts</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">All mounted filesystems, across all sources.</p>
      </div>
      <button @click="refresh" :disabled="loading" title="Refresh" class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
        <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
    </div>

    <div v-if="loading && !mounted.length && !unmounted.length" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6"><LoadingSpinner /> Loading…</div>
    <div v-else-if="error" class="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{{ error }}</div>

    <template v-else>
      <!-- Mounted filesystems -->
      <div v-if="mounted.length === 0" class="rounded-xl border border-dashed border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-6 text-center text-sm text-[var(--c-text-3)] mb-6">
        No filesystems currently mounted.
      </div>
      <div v-else class="rounded-xl border border-[var(--c-border)] overflow-hidden mb-8">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="bg-[var(--c-surface-deep)] border-b border-[var(--c-border)] text-[var(--c-text-3)] text-xs uppercase tracking-wide">
              <th class="text-left px-4 py-3 font-medium">Mount point</th>
              <th class="text-left px-4 py-3 font-medium">Device</th>
              <th class="text-left px-4 py-3 font-medium w-28">Source</th>
              <th class="text-left px-4 py-3 font-medium w-16">FS</th>
              <th class="text-left px-4 py-3 font-medium w-44">Used / Total</th>
              <th class="text-right px-4 py-3 font-medium w-24">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--c-border)]">
            <tr v-for="e in mounted" :key="e.key" class="hover:bg-[var(--c-hover)]/30 transition-colors">
              <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-1)]">{{ e.mountpoint }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-3)] truncate max-w-0 w-40">{{ e.device }}</td>
              <td class="px-4 py-2.5">
                <button @click="emit('navigate', sourceNavTarget[e.source])"
                  :class="['inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-sm border transition-colors', sourceBadgeClass[e.source]]">
                  {{ e.sourceLabel }} →
                </button>
              </td>
              <td class="px-4 py-2.5 font-mono text-[10px] text-[var(--c-text-3)] uppercase">{{ e.fstype }}</td>
              <td class="px-4 py-2.5">
                <div v-if="e.usageTotal > 0">
                  <div class="flex justify-between text-[10px] text-[var(--c-text-3)] mb-1">
                    <span>{{ fmtBytes(e.usageUsed) }}</span>
                    <span>{{ fmtBytes(e.usageTotal) }}</span>
                  </div>
                  <div class="h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                    <div class="h-full rounded-full" :class="usageBarClass(usagePct(e.bd))" :style="{ width: usagePct(e.bd) + '%' }"/>
                  </div>
                  <div class="text-[10px] text-[var(--c-text-3)] mt-0.5">{{ fmtBytes(e.usageFree) }} free</div>
                </div>
                <span v-else class="text-[10px] text-[var(--c-text-3)] italic">—</span>
              </td>
              <td class="px-4 py-2.5 text-right">
                <button v-if="!e.bd.isSystem" @click="openUmount(e.bd)"
                  class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-warning/50 hover:text-warning transition-colors">
                  Unmount
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Unmounted with filesystem -->
      <template v-if="unmounted.length > 0">
        <h3 class="text-sm font-medium text-[var(--c-text-2)] mb-3">Not mounted</h3>
        <div class="rounded-xl border border-[var(--c-border)] overflow-hidden">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="bg-[var(--c-surface-deep)] border-b border-[var(--c-border)] text-[var(--c-text-3)] text-xs uppercase tracking-wide">
                <th class="text-left px-4 py-3 font-medium">Device</th>
                <th class="text-left px-4 py-3 font-medium w-28">Source</th>
                <th class="text-left px-4 py-3 font-medium w-16">FS</th>
                <th class="text-left px-4 py-3 font-medium w-24">Taille</th>
                <th class="text-right px-4 py-3 font-medium w-32">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--c-border)]">
              <tr v-for="e in unmounted" :key="e.key" class="hover:bg-[var(--c-hover)]/30 transition-colors">
                <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-2)]">{{ e.device }}</td>
                <td class="px-4 py-2.5">
                  <button @click="emit('navigate', sourceNavTarget[e.source])"
                    :class="['inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-sm border transition-colors', sourceBadgeClass[e.source]]">
                    {{ e.sourceLabel }} →
                  </button>
                </td>
                <td class="px-4 py-2.5 font-mono text-[10px] text-[var(--c-text-3)] uppercase">{{ e.fstype }}</td>
                <td class="px-4 py-2.5 text-xs text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(e.size) }}</td>
                <td class="px-4 py-2.5 text-right flex items-center justify-end gap-1.5">
                  <button @click="openFormat(e.bd)"
                    class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                    Format
                  </button>
                  <button @click="openMount(e.bd)"
                    class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-success/50 hover:text-success transition-colors">
                    Mount
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
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
                    <span class="text-[10px] px-1.5 py-0.5 rounded-sm"
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
              <input v-model="mountDlg.persist" type="checkbox" class="mt-0.5 accent-accent"/>
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
              <input v-model="umountDlg.rmFstab" type="checkbox" class="mt-0.5 accent-accent"/>
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

  </div>
</template>
