<script setup lang="ts">
import type { StorageLocation } from '../../lib/storage-nav'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed } from 'vue'
import { useStorageData, fmtBytes, usagePct, usageBarClass, lvToBlockDev, raidLevelLabel, deviceRole, type BlockDev } from './store'
import DeviceFormatWizard from './dialogs/DeviceFormatWizard.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'
import VolumeHealthPanel from './VolumeHealthPanel.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const emit = defineEmits<{ navigate: [target: StorageLocation] }>()

const { loading, error, devices, raids, lvmLVs, refresh: refreshStorage } = useStorageData()
const volumePanel = ref<InstanceType<typeof VolumeHealthPanel> | null>(null)
function refresh() {
  void refreshStorage()
  void volumePanel.value?.refresh()
}

// ── Aggregated mount data ─────────────────────────────────────────────────────

type MountSource = 'disk' | 'raid' | 'lvm'

type MountEntry = {
  key:        string
  device:     string      // /dev/sdb1
  mountpoint: string
  fstype:     string
  source:     MountSource
  sourceLabel: string     // "RAID 1" | "LVM vg0/lv0" | "sdb"
  /** The page of the device the mount comes from (#40). */
  target:     StorageLocation
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
  target:      StorageLocation
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
      target:      { kind: 'disk', name: parentDisk?.name ?? bd.name },
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
      target:      { kind: 'array', name: r.name },
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
      target:      { kind: 'vg', name: lv.vgName },
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
    // RAID/LVM members carry a signature, not a mountable filesystem.
    if (deviceRole(bd)) continue
    const parentDisk = devices.value.find(d => bd.name.startsWith(d.name) && d.type === 'disk')
    entries.push({
      key:         `disk:${bd.name}`,
      device:      `/dev/${bd.name}`,
      fstype:      bd.fstype,
      source:      'disk',
      sourceLabel: parentDisk?.name ?? bd.name,
      target:      { kind: 'disk', name: parentDisk?.name ?? bd.name },
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
      target:      { kind: 'array', name: r.name },
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
      target:      { kind: 'vg', name: lv.vgName },
      size:        lv.size,
      bd,
    })
  }

  return entries
})

const sourceBadgeClass: Record<MountSource, string> = {
  disk:  'bg-muted text-muted-foreground border-border hover:border-input',
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
        <h2 class="text-lg font-semibold text-foreground">Mounts</h2>
        <p class="text-sm text-muted-foreground mt-0.5">All mounted filesystems, across all sources.</p>
      </div>
      <button @click="refresh" :disabled="loading" title="Refresh" class="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
        <LoadingSpinner v-if="loading" class="text-base" />
        <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
    </div>

    <LoadingState v-if="loading && !mounted.length && !unmounted.length" variant="block" />
    <div v-else-if="error" role="alert" class="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{{ error }}</div>

    <template v-else>
      <VolumeHealthPanel ref="volumePanel" />

      <!-- Mounted filesystems -->
      <div v-if="mounted.length === 0" class="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground mb-6">
        No filesystems currently mounted.
      </div>
      <div v-else class="mb-8">
        <div class="space-y-2 @3xl/content:hidden"><article v-for="e in mounted" :key="e.key" class="rounded-xl border border-border bg-card p-3"><div class="flex min-w-0 items-start justify-between gap-2"><div class="min-w-0"><strong class="block truncate font-mono text-xs text-foreground" :title="e.mountpoint">{{e.mountpoint}}</strong><p class="mt-1 truncate font-mono text-2xs text-muted-foreground" :title="e.device">{{e.device}}</p></div><Badge variant="secondary">{{e.fstype}}</Badge></div><div v-if="e.usageTotal>0" class="mt-3"><div class="mb-1 flex justify-between text-2xs text-muted-foreground"><span>{{fmtBytes(e.usageUsed)}} used</span><span>{{fmtBytes(e.usageFree)}} free</span></div><div class="h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full" :class="usageBarClass(usagePct(e.bd))" :style="{width:usagePct(e.bd)+'%'}"/></div></div><div class="mt-3 flex items-center justify-between"><button @click="emit('navigate',e.target)" class="text-xs text-muted-foreground">{{e.sourceLabel}} →</button><Button variant="outline" size="xs" v-if="!e.bd.isSystem" @click="openUmount(e.bd)">Unmount</Button></div></article></div>
        <div class="hidden rounded-xl border border-border overflow-hidden @3xl/content:block">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="bg-muted border-b border-border text-muted-foreground text-xs uppercase tracking-caps">
              <th class="text-left px-4 py-3 font-medium">Mount point</th>
              <th class="text-left px-4 py-3 font-medium">Device</th>
              <th class="text-left px-4 py-3 font-medium w-28">Source</th>
              <th class="text-left px-4 py-3 font-medium w-16">FS</th>
              <th class="text-left px-4 py-3 font-medium w-44">Used / Total</th>
              <th class="text-right px-4 py-3 font-medium w-24">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="e in mounted" :key="e.key" class="hover:bg-accent/30 transition-colors">
              <td class="px-4 py-2.5 font-mono text-xs text-foreground">{{ e.mountpoint }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-muted-foreground truncate max-w-0 w-40">{{ e.device }}</td>
              <td class="px-4 py-2.5">
                <button @click="emit('navigate', e.target)"
                  :class="['inline-flex items-center gap-1 text-2xs font-medium px-1.5 py-0.5 rounded-sm border transition-colors', sourceBadgeClass[e.source]]">
                  {{ e.sourceLabel }} →
                </button>
              </td>
              <td class="px-4 py-2.5 font-mono text-2xs text-muted-foreground uppercase">{{ e.fstype }}</td>
              <td class="px-4 py-2.5">
                <div v-if="e.usageTotal > 0">
                  <div class="flex justify-between text-2xs text-muted-foreground mb-1">
                    <span>{{ fmtBytes(e.usageUsed) }}</span>
                    <span>{{ fmtBytes(e.usageTotal) }}</span>
                  </div>
                  <div class="h-1 bg-muted rounded-full overflow-hidden">
                    <div class="h-full rounded-full" :class="usageBarClass(usagePct(e.bd))" :style="{ width: usagePct(e.bd) + '%' }"/>
                  </div>
                  <div class="text-2xs text-muted-foreground mt-0.5">{{ fmtBytes(e.usageFree) }} free</div>
                </div>
                <span v-else class="text-2xs text-muted-foreground">-</span>
              </td>
              <td class="px-4 py-2.5 text-right">
                <button v-if="!e.bd.isSystem" @click="openUmount(e.bd)"
                  class="text-2xs px-2 py-0.5 rounded-sm border border-border text-muted-foreground hover:border-warning/50 hover:text-warning transition-colors">
                  Unmount
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>

      <!-- Unmounted with filesystem -->
      <template v-if="unmounted.length > 0">
        <h3 class="text-sm font-medium text-foreground/80 mb-3">Not mounted</h3>
        <div class="space-y-2 @3xl/content:hidden"><article v-for="e in unmounted" :key="e.key" class="rounded-xl border border-border bg-card p-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><strong class="block truncate font-mono text-xs text-foreground">{{e.device}}</strong><p class="mt-1 text-2xs text-muted-foreground">{{e.fstype}} · {{fmtBytes(e.size)}}</p></div><Badge variant="secondary">{{e.sourceLabel}}</Badge></div><div class="mt-3 flex justify-end gap-2"><Button variant="outline" size="xs" @click="openFormat(e.bd)">Format</Button><Button size="xs" @click="openMount(e.bd)">Mount</Button></div></article></div>
        <div class="hidden rounded-xl border border-border overflow-hidden @3xl/content:block">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="bg-muted border-b border-border text-muted-foreground text-xs uppercase tracking-caps">
                <th class="text-left px-4 py-3 font-medium">Device</th>
                <th class="text-left px-4 py-3 font-medium w-28">Source</th>
                <th class="text-left px-4 py-3 font-medium w-16">FS</th>
                <th class="text-left px-4 py-3 font-medium w-24">Taille</th>
                <th class="text-right px-4 py-3 font-medium w-32">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="e in unmounted" :key="e.key" class="hover:bg-accent/30 transition-colors">
                <td class="px-4 py-2.5 font-mono text-xs text-foreground/80">{{ e.device }}</td>
                <td class="px-4 py-2.5">
                  <button @click="emit('navigate', e.target)"
                    :class="['inline-flex items-center gap-1 text-2xs font-medium px-1.5 py-0.5 rounded-sm border transition-colors', sourceBadgeClass[e.source]]">
                    {{ e.sourceLabel }} →
                  </button>
                </td>
                <td class="px-4 py-2.5 font-mono text-2xs text-muted-foreground uppercase">{{ e.fstype }}</td>
                <td class="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{{ fmtBytes(e.size) }}</td>
                <td class="px-4 py-2.5 text-right flex items-center justify-end gap-1.5">
                  <button @click="openFormat(e.bd)"
                    class="text-2xs px-2 py-0.5 rounded-sm border border-border text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors">
                    Format
                  </button>
                  <button @click="openMount(e.bd)"
                    class="text-2xs px-2 py-0.5 rounded-sm border border-border text-muted-foreground hover:border-success/50 hover:text-success transition-colors">
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
    <DeviceFormatWizard  ref="formatWiz" @done="refresh" @mount="d => mountDlg?.open(d)" />
    <DeviceMountDialog   ref="mountDlg"  @done="refresh" />
    <DeviceUnmountDialog ref="umountDlg" @done="refresh" />

  </div>
</template>
