<script setup lang="ts">
import { ref, computed } from 'vue'
import { useStorageData, fmtBytes, usagePct, usageBarClass, lvToBlockDev, raidLevelLabel, type BlockDev } from '../../composables/useStorageData'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import DeviceFormatWizard from './dialogs/DeviceFormatWizard.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'

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

// Device format/mount/unmount dialogs are shared components (see ./dialogs);
// these thin wrappers open them via template refs and refresh on success.
const formatWiz = ref<InstanceType<typeof DeviceFormatWizard> | null>(null)
const mountDlg  = ref<InstanceType<typeof DeviceMountDialog>  | null>(null)
const umountDlg = ref<InstanceType<typeof DeviceUnmountDialog> | null>(null)
function openFormat(dev: BlockDev) { formatWiz.value?.open(dev) }
function openMount(dev: BlockDev)  { mountDlg.value?.open(dev) }
function openUmount(dev: BlockDev) { umountDlg.value?.open(dev) }
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

    <!-- Shared device dialogs (format / mount / unmount) -->
    <DeviceFormatWizard  ref="formatWiz" @done="refresh" />
    <DeviceMountDialog   ref="mountDlg"  @done="refresh" />
    <DeviceUnmountDialog ref="umountDlg" @done="refresh" />

  </div>
</template>
