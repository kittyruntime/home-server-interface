<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, CircleXIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/vue'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { StorageLocation } from '../../lib/storage-nav'
import { memberOwner } from './device-state'
import { LOADING } from '../../lib/loading'
import LoadingState from '../ui/LoadingState.vue'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import { ref, computed } from 'vue'
import {
  fmtBytes, fmtHours, fmtTiB, usagePct, usageBarClass, lvToDmName,
  deviceRole, isLockedByMembership, roleLabel,
  type BlockDev, type DeviceRole, type LvmLV,
} from './store'
import { type SmartResult, smartStatus, smartHealth } from './smart'

/* One physical disk with its SMART panel and everything built on it:
   partitions, RAID/LVM membership, filesystems and mount points. Actions are
   emitted; the parent owns the dialogs. */
const props = defineProps<{
  disk:      BlockDev
  smart?:    SmartResult
  smartOpen: boolean
  devices:   BlockDev[]
  lvs:       LvmLV[]
}>()

const emit = defineEmits<{
  navigate:    [target: 'raid' | 'lvm' | StorageLocation]
  toggleSmart: []
  format:      [dev: BlockDev]
  mount:       [dev: BlockDev]
  umount:      [dev: BlockDev]
  partInit:    [disk: BlockDev]
  partCreate:  [disk: BlockDev]
  partDelete:  [disk: BlockDev, part: BlockDev]
}>()

const status = computed(() => smartStatus(props.smart))

// Expandable danger zone (wipe the partition table).
const danger = ref(false)

// ── Hierarchy ─────────────────────────────────────────────────────────────────
// The tree is rooted at the physical disk. Each child node shows what it *feeds*:
// a partition can be a filesystem (mounted or not), a RAID member, or an LVM PV
// (in which case its LVs appear as nested children). This mirrors the physical
// reality: disk → partition → RAID/LVM → filesystem → mount point.

// RAID/LVM membership, including members of arrays/VGs that are not active.
function roleOf(dev: BlockDev): DeviceRole | null {
  return deviceRole(dev)
}

// A member opens the page of its array or volume group when it is known.
function openRole(role: { kind: 'raid' | 'lvm'; owner: string | null }) {
  if (role.owner) emit('navigate', role.kind === 'raid' ? { kind: 'array', name: role.owner } : { kind: 'vg', name: role.owner })
  else emit('navigate', role.kind)
}

function diskLocked(disk: BlockDev): boolean {
  return isLockedByMembership(disk)
}


// LVs belonging to a VG, as display rows.
function lvsOfVg(vgName: string) {
  return props.lvs.filter(l => l.vgName === vgName)
}

function lvMountpoint(lv: { vgName: string; name: string; path: string }): string {
  const dmName = lvToDmName({ name: lv.name, vgName: lv.vgName, size: 0, path: lv.path })
  const all: BlockDev[] = []
  function walk(d: BlockDev) { all.push(d); d.children?.forEach(walk) }
  props.devices.forEach(walk)
  return all.find(d => d.name === dmName)?.mountpoint ?? ''
}
</script>

<template>
<div
  class="rounded-xl border bg-card overflow-hidden flex"
  :class="disk.isSystem ? 'border-warning/20' : 'border-border'">
  <!-- Left stripe by type -->
  <div class="w-0.5 shrink-0"
    :class="disk.isSystem ? 'bg-warning/60' : disk.isRemovable ? 'bg-info/50' : 'bg-input'"/>
  <div class="flex-1 min-w-0">

    <!-- Disk header (tree root) -->
    <div class="flex items-center gap-3 px-4 py-3">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-mono text-sm font-semibold text-foreground">/dev/{{ disk.name }}</span>
          <span v-if="disk.model" class="text-2xs text-muted-foreground truncate">{{ disk.model }}</span>
          <span class="text-2xs text-muted-foreground tabular-nums">{{ fmtBytes(disk.size) }}</span>
          <span v-if="disk.isSystem" class="inline-flex items-center gap-1 text-2xs font-semibold px-1.5 py-0.5 rounded-sm bg-warning/10 text-warning border border-warning/20">
            <CircleAlertIcon class="w-2.5 h-2.5" aria-hidden="true" />
            SYSTEM
          </span>
          <span v-if="disk.isRemovable" class="text-2xs px-1.5 py-0.5 rounded-sm bg-info/10 text-info border border-info/20">USB</span>
          <!-- Whole-disk RAID/LVM member: read-only, SMART only -->
          <Button variant="outline" size="xs" v-if="roleOf(disk)" @click="openRole(roleOf(disk)!)"
            :title="'This disk is used by ' + roleLabel(roleOf(disk)!) + '. Only the SMART check is available.'"
            class="text-2xs bg-info/10 text-info border-info/20 hover:bg-info/20">{{ roleLabel(roleOf(disk)!) }} →</Button>
        </div>
        <div v-if="disk.byId" class="text-2xs font-mono text-muted-foreground mt-0.5 truncate" :title="`/dev/disk/by-id/${disk.byId}: stable name, unlike /dev/${disk.name}`">/dev/disk/by-id/{{ disk.byId }}</div>
        <div v-if="disk.isSystem" class="text-2xs text-warning/70 mt-0.5">Operating system disk: no modifications allowed</div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <!-- Health badge -->
        <button @click="emit('toggleSmart')" title="S.M.A.R.T. health"
          :class="['inline-flex items-center gap-1.5 text-2xs font-semibold px-2 py-1 rounded-lg border transition-colors',
            status === 'passed'  ? 'bg-success/10 border-success/25 text-success hover:bg-success/20' :
            status === 'warning' ? 'bg-warning/10 border-warning/25 text-warning hover:bg-warning/20' :
            status === 'failed'  ? 'bg-destructive/10 border-destructive/25 text-destructive hover:bg-destructive/20' :
            status === 'loading' ? 'bg-muted border-border text-muted-foreground' :
            'bg-muted border-border text-muted-foreground hover:border-input hover:text-foreground/80']">
          <LoadingSpinner v-if="status === 'loading'" class="text-xs" />
          <span v-else class="w-1.5 h-1.5 rounded-full"
            :class="status === 'passed' ? 'bg-success' : status === 'warning' ? 'bg-warning' : status === 'failed' ? 'bg-destructive animate-pulse' : 'bg-muted-foreground/40'"/>
          <span v-if="status === 'passed'">Healthy</span>
          <span v-else-if="status === 'warning'">Warning</span>
          <span v-else-if="status === 'failed'">Failed</span>
          <span v-else-if="status === 'loading'">…</span>
          <span v-else>SMART</span>
          <template v-if="smart?.available && smart?.temperature">
            <span class="opacity-50">·</span>
            <span :class="(smart?.temperature ?? 0) >= 55 ? 'text-destructive' : (smart?.temperature ?? 0) >= 40 ? 'text-warning' : ''">{{ smart?.temperature }}°C</span>
          </template>
        </button>
        <!-- + Partition button (non-system only) -->
        <Button variant="outline" size="xs" v-if="!disk.isSystem && !diskLocked(disk)" @click="emit('partCreate', disk)"
          class="text-foreground/80 hover:border-primary/50 hover:text-primary">
          + Partition
        </Button>
      </div>
    </div>

    <!-- SMART health panel (expandable) -->
    <div v-if="smartOpen" class="border-t border-border bg-muted/40">
      <!-- sc = SmartResult | undefined, scoped for TS narrowing.
           Single-element array: disk.name is a valid unique key here. -->
      <!-- eslint-disable-next-line vue/valid-v-for -->
      <template v-for="sc in [smart]" :key="disk.name">
        <!-- Loading -->
        <LoadingState v-if="sc?._loading" variant="inline" :label="LOADING.readingSmart" class="px-4 py-4" />

        <!-- Error -->
        <div v-else-if="sc?._error" class="px-4 py-3 text-sm text-destructive">
          {{ sc._error }}
        </div>

        <!-- Unavailable -->
        <div v-else-if="sc && !sc.available" class="px-4 py-3 text-sm text-muted-foreground">
          S.M.A.R.T. not supported by this device, or smartctl is not installed. Virtual disks and many USB enclosures do not expose it.
        </div>

        <!-- Data -->
        <template v-else-if="sc?.available">
          <!-- Overview row -->
          <div class="px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border">
            <div class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full shrink-0"
                :class="status === 'passed' ? 'bg-success' : status === 'warning' ? 'bg-warning' : status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/40'"/>
              <span class="text-xs font-semibold"
                :class="status === 'passed' ? 'text-success' : status === 'warning' ? 'text-warning' : status === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
                {{ smartHealth(sc) === 'passed' ? 'PASSED' : smartHealth(sc) === 'failed' ? 'FAILED' : 'NO HEALTH STATUS' }}
              </span>
              <span v-for="w in sc.warnings ?? []" :key="w" class="text-2xs text-warning">· {{ w }}</span>
            </div>
            <div v-if="sc.temperature" class="flex items-center gap-1 text-xs">
              <span :class="sc.temperature >= 55 ? 'text-destructive font-semibold' : sc.temperature >= 40 ? 'text-warning' : 'text-foreground/80'">
                {{ sc.temperature }}°C
              </span>
            </div>
            <div v-if="sc.powerOnHours" class="text-xs text-muted-foreground">
              {{ fmtHours(sc.powerOnHours) }} powered on
            </div>
            <div v-if="sc.powerCycles" class="text-xs text-muted-foreground">
              {{ sc.powerCycles.toLocaleString() }} power cycles
            </div>
            <div class="ml-auto text-2xs px-1.5 py-0.5 rounded-sm bg-muted border border-border text-muted-foreground">
              {{ sc.nvme ? 'NVMe' : sc.rotationRate === 0 ? 'SSD' : `HDD ${sc.rotationRate} RPM` }}
            </div>
          </div>

          <!-- Device info row -->
          <div v-if="sc.serialNumber || sc.firmware" class="px-4 py-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground border-b border-border">
            <span v-if="sc.modelFamily"><span class="text-foreground/80">Family</span> {{ sc.modelFamily }}</span>
            <span v-if="sc.serialNumber"><span class="text-foreground/80">S/N</span> <span class="font-mono">{{ sc.serialNumber }}</span></span>
            <span v-if="sc.firmware"><span class="text-foreground/80">FW</span> <span class="font-mono">{{ sc.firmware }}</span></span>
          </div>

          <!-- NVMe health log -->
          <div v-if="sc.nvme" class="px-4 py-3 space-y-2">
            <div class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground mb-2">NVMe Health Log</div>
            <div class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
              <div class="flex justify-between gap-2">
                <span class="text-muted-foreground">Critical Warning</span>
                <span :class="sc.nvme.criticalWarning > 0 ? 'text-destructive font-semibold' : 'text-foreground/80'">{{ sc.nvme.criticalWarning }}</span>
              </div>
              <div class="flex justify-between gap-2">
                <span class="text-muted-foreground">Media Errors</span>
                <span :class="sc.nvme.mediaErrors > 0 ? 'text-destructive font-semibold' : 'text-foreground/80'">{{ sc.nvme.mediaErrors }}</span>
              </div>
              <div class="flex justify-between gap-2">
                <span class="text-muted-foreground">Available Spare</span>
                <span :class="sc.nvme.availableSpare <= sc.nvme.availableSpareThresh ? 'text-destructive font-semibold' : 'text-foreground/80'">{{ sc.nvme.availableSpare }}% <span class="text-muted-foreground">(min {{ sc.nvme.availableSpareThresh }}%)</span></span>
              </div>
              <div class="flex justify-between gap-2">
                <span class="text-muted-foreground">Percentage Used</span>
                <span :class="sc.nvme.percentageUsed >= 90 ? 'text-destructive font-semibold' : sc.nvme.percentageUsed >= 70 ? 'text-warning' : 'text-foreground/80'">{{ sc.nvme.percentageUsed }}%</span>
              </div>
              <div v-if="sc.nvme.dataReadTiB > 0" class="flex justify-between gap-2">
                <span class="text-muted-foreground">Data Read</span>
                <span class="text-foreground/80 font-mono">{{ fmtTiB(sc.nvme.dataReadTiB) }}</span>
              </div>
              <div v-if="sc.nvme.dataWrittenTiB > 0" class="flex justify-between gap-2">
                <span class="text-muted-foreground">Data Written</span>
                <span class="text-foreground/80 font-mono">{{ fmtTiB(sc.nvme.dataWrittenTiB) }}</span>
              </div>
            </div>
          </div>

          <!-- ATA attributes table -->
          <div v-if="sc.attributes.length > 0" class="px-4 pb-4 pt-3">
            <div class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground mb-2">ATA Attributes</div>
            <div class="rounded-lg overflow-hidden border border-border">
              <Table class="w-full text-2xs border-collapse">
                <TableHeader>
                  <TableRow class="bg-muted text-muted-foreground">
                    <TableHead class="text-left px-2.5 py-1.5 font-medium w-8">ID</TableHead>
                    <TableHead class="text-left px-2.5 py-1.5 font-medium">Attribute</TableHead>
                    <TableHead class="text-right px-2.5 py-1.5 font-medium tabular-nums">Value</TableHead>
                    <TableHead class="text-right px-2.5 py-1.5 font-medium tabular-nums">Worst</TableHead>
                    <TableHead class="text-right px-2.5 py-1.5 font-medium tabular-nums">Thresh</TableHead>
                    <TableHead class="text-right px-2.5 py-1.5 font-medium tabular-nums">Raw</TableHead>
                    <TableHead class="text-center px-2.5 py-1.5 font-medium w-8"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody class="divide-y divide-border">
                  <TableRow v-for="attr in sc.attributes" :key="attr.id"
                    :class="['transition-colors', attr.failed ? 'bg-destructive/8' : attr.isCritical && attr.raw > 0 ? 'bg-warning/6' : '']">
                    <TableCell class="px-2.5 py-1.5 font-mono text-muted-foreground">{{ attr.id }}</TableCell>
                    <TableCell class="px-2.5 py-1.5 font-mono"
                      :class="attr.failed ? 'text-destructive font-semibold' : attr.isCritical ? 'text-foreground' : 'text-foreground/80'">
                      {{ attr.name.replace(/_/g, ' ') }}
                    </TableCell>
                    <TableCell class="px-2.5 py-1.5 tabular-nums text-right text-foreground/80">{{ attr.value }}</TableCell>
                    <TableCell class="px-2.5 py-1.5 tabular-nums text-right text-muted-foreground">{{ attr.worst }}</TableCell>
                    <TableCell class="px-2.5 py-1.5 tabular-nums text-right text-muted-foreground">{{ attr.thresh }}</TableCell>
                    <TableCell class="px-2.5 py-1.5 tabular-nums text-right font-mono"
                      :class="attr.failed ? 'text-destructive font-semibold' : attr.isCritical && attr.raw > 0 ? 'text-warning font-semibold' : 'text-foreground/80'">
                      {{ attr.raw.toLocaleString() }}
                    </TableCell>
                    <TableCell class="px-2.5 py-1.5 text-center">
                      <CircleXIcon v-if="attr.failed" class="w-3 h-3 text-destructive mx-auto" aria-hidden="true" />
                      <TriangleAlertIcon v-else-if="attr.isCritical && attr.raw > 0" class="w-3 h-3 text-warning mx-auto" aria-hidden="true" />
                      <CircleCheckIcon v-else-if="attr.isCritical" class="w-3 h-3 text-success/60 mx-auto" aria-hidden="true" />
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </div>
        </template>
      </template>
    </div>

    <!-- Children: partitions and what they feed -->
    <div v-if="disk.children && disk.children.length > 0" class="border-t border-border divide-y divide-border">
      <template v-for="part in disk.children.filter(c => c.type !== 'swap')" :key="part.name">
        <div class="group/part flex items-center gap-3 px-4 py-2.5 hover:bg-accent/30 transition-colors">
          <!-- Status dot -->
          <div class="w-1.5 h-1.5 rounded-full shrink-0"
            :class="part.isSystem ? 'bg-warning/60' : part.mountpoint ? 'bg-success/70' : 'bg-muted-foreground/25'"/>
          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-mono text-xs text-foreground/80">/dev/{{ part.name }}</span>
              <span class="text-2xs text-muted-foreground tabular-nums">{{ fmtBytes(part.size) }}</span>
              <span v-if="part.fstype" class="text-2xs font-mono px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground uppercase border border-border">{{ part.fstype }}</span>
              <span v-else-if="!roleOf(part)" class="text-2xs text-muted-foreground/60">unformatted</span>
              <!-- Role: RAID member -->
              <Button variant="outline" size="xs" v-if="memberOwner(part, 'raid')" @click="emit('navigate', { kind: 'array', name: memberOwner(part, 'raid')! })"
                class="text-2xs bg-info/10 text-info border-info/20 hover:bg-info/20">
                RAID {{ memberOwner(part, 'raid') }} →
              </Button>
              <!-- Role: LVM PV -->
              <Button variant="outline" size="xs" v-if="memberOwner(part, 'lvm')" @click="emit('navigate', { kind: 'vg', name: memberOwner(part, 'lvm')! })"
                class="text-2xs bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20">
                LVM {{ memberOwner(part, 'lvm') }} →
              </Button>
              <!-- Role: member of an array/VG that is not active -->
              <span v-if="roleOf(part) && !roleOf(part)!.owner"
                class="text-2xs px-1.5 py-0.5 rounded-sm bg-warning/10 text-warning border border-warning/20">{{ roleLabel(roleOf(part)!) }}</span>
            </div>
            <div v-if="part.mountpoint" class="text-2xs font-mono text-muted-foreground mt-0.5">↳ {{ part.mountpoint }}</div>
            <div v-if="part.usageTotal > 0" class="mt-1.5 flex items-center gap-2">
              <div class="w-24 h-0.5 bg-muted rounded-full overflow-hidden">
                <div class="h-full rounded-full" :class="usageBarClass(usagePct(part))" :style="{ width: usagePct(part) + '%' }"/>
              </div>
              <span class="text-2xs text-muted-foreground tabular-nums">{{ fmtBytes(part.usageFree) }} free</span>
            </div>
            <!-- Nested: LVs of the VG this partition is a PV of -->
            <div v-if="memberOwner(part, 'lvm') && lvsOfVg(memberOwner(part, 'lvm')!).length" class="mt-1.5 space-y-1">
              <div v-for="lv in lvsOfVg(memberOwner(part, 'lvm')!)" :key="lv.path" class="flex items-center gap-2 text-2xs">
                <span class="text-muted-foreground/50">└─</span>
                <span class="font-mono text-purple-400">{{ lv.vgName }}/{{ lv.name }}</span>
                <span class="text-muted-foreground tabular-nums">{{ fmtBytes(lv.size) }}</span>
                <span v-if="lvMountpoint(lv)" class="font-mono text-muted-foreground">↳ {{ lvMountpoint(lv) }}</span>
              </div>
            </div>
          </div>
          <!-- Actions: revealed on hover, hidden by default -->
          <div v-if="!part.isSystem" class="flex items-center gap-1 shrink-0 opacity-0 group-hover/part:opacity-100 transition-opacity">
            <Button variant="outline" size="xs" v-if="!part.mountpoint && !roleOf(part)" @click="emit('format', part)"
              class="text-2xs text-muted-foreground hover:border-primary/50 hover:text-primary">Format</Button>
            <Button variant="outline" size="xs" v-if="part.fstype && !part.mountpoint && !roleOf(part)" @click="emit('mount', part)"
              class="text-2xs text-muted-foreground hover:border-success/50 hover:text-success">Mount</Button>
            <Button variant="outline" size="xs" v-if="part.mountpoint" @click="emit('umount', part)"
              class="text-2xs text-muted-foreground hover:border-warning/50 hover:text-warning">Unmount</Button>
            <div class="w-px h-3 bg-border mx-1"/>
            <Button variant="ghost" size="icon-xs" v-if="!part.mountpoint && !roleOf(part)" @click="emit('partDelete', disk, part)"
              title="Delete this partition"
              class="text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10">
              <Trash2Icon class="w-3.5 h-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </template>
    </div>

    <!-- Unpartitioned raw disk -->
    <div v-else-if="!disk.isSystem" class="border-t border-border">
      <!-- Has a filesystem directly on the raw disk -->
      <div v-if="disk.fstype" class="flex items-center gap-3 px-4 py-2.5">
        <div class="w-1.5 h-1.5 rounded-full shrink-0 bg-primary/60"/>
        <div class="flex-1 min-w-0">
          <span class="text-2xs font-mono px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground uppercase border border-border">{{ disk.fstype }}</span>
          <div v-if="disk.mountpoint" class="text-2xs font-mono text-muted-foreground mt-0.5">↳ {{ disk.mountpoint }}</div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <Button variant="outline" size="xs" v-if="!disk.mountpoint && !roleOf(disk)" @click="emit('format', disk)"
            class="text-2xs text-muted-foreground hover:border-primary/50 hover:text-primary">Format</Button>
          <Button variant="outline" size="xs" v-if="!disk.mountpoint && !roleOf(disk)" @click="emit('mount', disk)"
            class="text-2xs text-muted-foreground hover:border-success/50 hover:text-success">Mount</Button>
          <Button variant="outline" size="xs" v-if="disk.mountpoint" @click="emit('umount', disk)"
            class="text-2xs text-muted-foreground hover:border-warning/50 hover:text-warning">Unmount</Button>
        </div>
      </div>
      <!-- Truly blank disk: no partition table, no filesystem -->
      <div v-else class="flex items-center gap-3 px-4 py-2.5">
        <div class="w-1.5 h-1.5 rounded-full shrink-0 bg-muted-foreground/20"/>
        <div class="flex-1 min-w-0">
          <span class="text-2xs text-muted-foreground">No partition table. Create one to start using this disk.</span>
        </div>
        <Button variant="outline" size="xs" @click="emit('partInit', disk)"
          class="shrink-0 text-2xs text-muted-foreground hover:border-primary/50 hover:text-primary">
          Create partition table…
        </Button>
      </div>
    </div>

    <!-- Expandable danger zone: only for disks that already have partitions -->
    <div v-if="!disk.isSystem && disk.children && disk.children.length > 0 && !diskLocked(disk)" class="border-t border-border">
      <button @click="danger = !danger"
        class="w-full flex items-center gap-2 px-4 py-2 text-2xs text-muted-foreground/60 hover:text-muted-foreground transition-colors">
        <ChevronRightIcon class="w-3 h-3 shrink-0 transition-transform" :class="danger ? 'rotate-90' : ''" aria-hidden="true" />
        Advanced
      </button>
      <div v-if="danger" class="px-4 pb-3 pt-0.5">
        <div class="flex items-start gap-3 p-3 rounded-lg border border-destructive/20 bg-destructive/5">
          <TriangleAlertIcon class="w-3.5 h-3.5 text-destructive/70 mt-0.5 shrink-0" aria-hidden="true" />
          <div class="flex-1 min-w-0">
            <p class="text-2xs text-foreground/80 font-medium mb-0.5">Wipe and create a new partition table</p>
            <p class="text-2xs text-muted-foreground">Permanently destroys all existing partitions and data on <span class="font-mono">/dev/{{ disk.name }}</span>. Cannot be undone.</p>
            <Button variant="outline" size="xs" @click="emit('partInit', disk)"
              class="mt-2 text-2xs border-destructive/30 text-destructive/80 hover:border-destructive/60 hover:text-destructive hover:bg-destructive/10">
              Create partition table…
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</template>
