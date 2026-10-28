<script setup lang="ts">
import { CheckIcon, EllipsisVerticalIcon, CircleAlertIcon, PlusIcon, RefreshCwIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/vue'
import type { StorageLocation } from '../../lib/storage-nav'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import LoadingState from '../ui/LoadingState.vue'
import { applyPlanned } from '../../lib/plan'
import { pvCreateNeeded, withOrphanPvs } from './lvm-wizard'
import { ref, computed, watch } from 'vue'
import { useStorageData, fmtBytes, usagePct, usageBarClass, lvToBlockDev, criticalMountPoints, claimableDevices, type BlockDev, type LvmVG, type LvmLV } from './store'
import { useHostTools } from './tools'
import DeviceFormatWizard from './dialogs/DeviceFormatWizard.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'
import ConfirmDestroyDialog from './dialogs/ConfirmDestroyDialog.vue'
import Modal from '../ui/Modal.vue'
import LvmIntro from './LvmIntro.vue'
import ImportFound from './ImportFound.vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

// `preselect`: whole disks picked in Devices; opens the create wizard with them.
// `only`: show just this array / volume group (its page, #40), without the
// section header and create entry points.
const props = defineProps<{ preselect?: string[]; only?: string }>()
const emit = defineEmits<{ preselected: []; navigate: [target: StorageLocation] }>()

const { loading, error, devices, lvmPVs, lvmVGs, lvmLVs, refresh } = useStorageData()
const { isMissing } = useHostTools()

// ── Helpers ───────────────────────────────────────────────────────────────────

// Wrapper so template can call without passing devices each time
function lv2bd(lv: LvmLV): BlockDev {
  return lvToBlockDev(lv, devices.value)
}

// ── Computed ──────────────────────────────────────────────────────────────────

// Eligible for LVM PV: free disks/partitions and free assembled RAID arrays (worker usage)
// Orphan PVs (left by a wizard stopped after its first plan) are offered again.
const eligibleForLvm = computed<BlockDev[]>(() => withOrphanPvs(claimableDevices(devices.value, true), devices.value, lvmPVs.value))

// VG free space as percentage
function vgFreePct(vg: LvmVG): number {
  return vg.size > 0 ? Math.min(100, (vg.free / vg.size) * 100) : 0
}

// Whether a VG is system-owned (has an LV mounted at a critical path)
function isSystemVg(vgName: string): boolean {
  return lvmLVs.value
    .filter(l => l.vgName === vgName)
    .some(l => {
      const bd = lv2bd(l)
      return bd.isSystem || Object.keys(criticalMountPoints).some(mp => bd.mountpoint === mp)
    })
}

// ── LVM wizard ────────────────────────────────────────────────────────────────

const lvmWiz = ref<{
  step:      1 | 2 | 3
  pvDevs:    string[]
  vgName:    string
  lvName:    string
  lvSizeGB:  number
  busy:      boolean
  err:       string
} | null>(null)

function openLvmWizard(devs: string[] = []) {
  lvmWiz.value = { step: 1, pvDevs: [...devs], vgName: '', lvName: 'lv0', lvSizeGB: 0, busy: false, err: '' }
}

watch(() => props.preselect, devs => {
  if (!devs?.length) return
  openLvmWizard(devs)
  emit('preselected')
}, { immediate: true })

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
    // Disks already made PVs by an earlier, interrupted run are not prepared again.
    const toPrepare = pvCreateNeeded(w.pvDevs, lvmPVs.value)
    const total = toPrepare.length ? 3 : 2
    let n = 1
    if (toPrepare.length) {
      await applyPlanned('pv.create', { devices: toPrepare },
        { title: `Prepare disks for LVM (${n++} of ${total})`, actionLabel: 'Prepare disks' })
      await refresh()
    }
    await applyPlanned('vg.create', { name: w.vgName, devices: w.pvDevs },
      { title: `Create volume group ${w.vgName} (${n++} of ${total})`, actionLabel: 'Create volume group' })
    const sizeBytes = w.lvSizeGB > 0 ? Math.floor(w.lvSizeGB * 1024 ** 3) : 0
    await applyPlanned('lv.create', { vgName: w.vgName, lvName: w.lvName, sizeBytes },
      { title: `Create logical volume ${w.lvName} (${n} of ${total})`, actionLabel: 'Create logical volume' })
    lvmWiz.value = null
    await refresh()
  } catch (e: any) {
    w.err = e?.message ?? 'LVM creation failed'
  } finally {
    if (lvmWiz.value) w.busy = false
  }
}

// ── Add LV to existing VG ────────────────────────────────────────────────────

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
    await applyPlanned('lv.create', { vgName: d.vg.name, lvName: d.lvName, sizeBytes },
      { title: `Create logical volume ${d.lvName}`, actionLabel: 'Create logical volume' })
    addLvDlg.value = null
    await refresh()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to create LV'
  } finally {
    if (addLvDlg.value) d.busy = false
  }
}

// ── Remove LV confirmation ────────────────────────────────────────────────────

const removeLvDlg = ref<{ lv: LvmLV; busy: boolean; err: string } | null>(null)

async function doRemoveLv() {
  if (!removeLvDlg.value) return
  const d = removeLvDlg.value
  d.busy = true; d.err = ''
  try {
    await applyPlanned('lv.remove', { vgName: d.lv.vgName, lvName: d.lv.name },
      { title: `Delete logical volume ${d.lv.vgName}/${d.lv.name}`, actionLabel: `Delete ${d.lv.name}` })
    removeLvDlg.value = null
    await refresh()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to remove LV'
  } finally {
    if (removeLvDlg.value) d.busy = false
  }
}

// ── Remove VG confirmation ────────────────────────────────────────────────────

const removeVgDlg = ref<{ vg: LvmVG; busy: boolean; err: string } | null>(null)

async function doRemoveVg() {
  if (!removeVgDlg.value) return
  const d = removeVgDlg.value
  d.busy = true; d.err = ''
  try {
    await applyPlanned('vg.remove', { vgName: d.vg.name },
      { title: `Delete volume group ${d.vg.name}`, actionLabel: `Delete ${d.vg.name}` })
    removeVgDlg.value = null
    await refresh()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to remove VG'
  } finally {
    if (removeVgDlg.value) d.busy = false
  }
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


const shown = computed(() => props.only ? lvmVGs.value.filter(x => x.name === props.only) : lvmVGs.value)
</script>

<template>
  <div>
    <div v-if="!only" class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-foreground">Volume groups</h2>
        <p class="text-sm text-muted-foreground mt-0.5">Physical volumes, volume groups and logical volumes.</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="openLvmWizard()" :disabled="isMissing('pvcreate')"
          :title="isMissing('pvcreate') ? 'LVM tools are not installed: sudo apt install lvm2' : undefined">
          <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
          Create volume group…
        </Button>
        <Button variant="ghost" size="icon-sm" @click="refresh" :disabled="loading" title="Refresh" class="text-muted-foreground hover:text-foreground">
          <LoadingSpinner v-if="loading" class="text-base" />
          <RefreshCwIcon v-else class="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>
    </div>

    <LvmIntro v-if="!only" />

    <ImportFound v-if="!only" kind="lvm" @imported="refresh" />

    <LoadingState v-if="loading && !lvmVGs.length" variant="block" />
    <div v-else-if="error" role="alert" class="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{{ error }}</div>

    <!-- VG list -->
    <div v-if="!only" class="flex items-center justify-between mb-3">
      <span v-if="lvmVGs.length" class="text-2xs px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground tabular-nums">{{ lvmVGs.length }} volume group{{ lvmVGs.length !== 1 ? 's' : '' }}</span>
    </div>

    <div v-if="!only && !loading && lvmVGs.length === 0" class="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
      No LVM volume groups. Create one to get resizable logical volumes from one or more physical drives.
    </div>

    <div v-else class="space-y-3">
      <div v-for="vg in shown" :key="vg.name"
        class="rounded-xl border bg-card overflow-hidden flex"
        :class="isSystemVg(vg.name) ? 'border-warning/20' : 'border-border'">
        <!-- Left stripe -->
        <div class="w-0.5 shrink-0" :class="isSystemVg(vg.name) ? 'bg-warning/60' : 'bg-purple-500/50'"/>
        <div class="flex-1 min-w-0">
          <!-- VG header -->
          <div class="flex items-center gap-3 px-4 py-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <Button variant="link" v-if="!only" class="h-auto p-0 font-mono font-semibold text-foreground" @click="emit('navigate', { kind: 'vg', name: vg.name })">{{ vg.name }}</Button>
                <span v-else class="font-mono text-sm font-semibold text-foreground">{{ vg.name }}</span>
                <span class="text-2xs text-muted-foreground">{{ fmtBytes(vg.size) }}</span>
                <span class="text-2xs px-1.5 py-0.5 rounded-sm bg-purple-500/10 text-purple-400 shrink-0">{{ vg.pvCount }} PV · {{ vg.lvCount }} LV</span>
                <span v-if="isSystemVg(vg.name)" class="inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded-sm bg-warning/10 text-warning border border-warning/20">
                  <CircleAlertIcon class="w-2.5 h-2.5" aria-hidden="true" />
                  SYSTEM
                </span>
              </div>
              <!-- Capacity bar -->
              <div class="mt-2 flex items-center gap-2">
                <div class="flex-1 h-1 bg-muted rounded-full overflow-hidden max-w-[200px]">
                  <div class="h-full rounded-full bg-purple-400/70" :style="{ width: (100 - vgFreePct(vg)) + '%' }"/>
                </div>
                <span class="text-2xs text-muted-foreground tabular-nums shrink-0">{{ fmtBytes(vg.free) }} free</span>
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <Button variant="outline" size="xs" v-if="!isSystemVg(vg.name)" @click="addLvDlg = { vg, lvName: 'lv' + vg.lvCount, lvSizeGB: 0, busy: false, err: '' }"
                class="text-foreground/80 hover:border-purple-500/50 hover:text-purple-400">
                + Add LV
              </Button>
              <!-- ⋯ menu for VG -->
              <DropdownMenu v-if="!isSystemVg(vg.name)">
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="Volume group actions">
                    <EllipsisVerticalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="min-w-[176px]">
                  <DropdownMenuLabel class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Danger zone</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" @select="removeVgDlg = { vg, busy: false, err: '' }">
                    <Trash2Icon />
                    Remove VG…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <!-- PVs -->
          <div class="px-4 py-2 border-t border-border bg-muted/30">
            <div class="flex flex-wrap gap-1.5">
              <span v-for="pv in lvmPVs.filter(p => p.vgName === vg.name)" :key="pv.name"
                class="inline-flex items-center gap-1.5 text-2xs font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground border border-border">
                {{ pv.name }} <span class="text-muted-foreground/60">{{ fmtBytes(pv.size) }}</span>
              </span>
            </div>
          </div>

          <!-- LVs -->
          <div class="divide-y divide-border">
            <div v-if="lvmLVs.filter(l => l.vgName === vg.name).length === 0"
              class="px-4 py-3 text-2xs text-muted-foreground">
              No logical volumes. Click "+ Add LV" to create one.
            </div>
            <div v-for="lv in lvmLVs.filter(l => l.vgName === vg.name)" :key="lv.name"
              class="group/lv flex items-center gap-3 px-4 py-2.5 hover:bg-accent/30 transition-colors">
              <div class="w-1.5 h-1.5 rounded-full shrink-0"
                :class="lv2bd(lv).isSystem ? 'bg-warning/70' : lv2bd(lv).mountpoint ? 'bg-success/70' : 'bg-purple-400/40'"/>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="font-mono text-xs text-foreground/80">{{ lv.path }}</span>
                  <span class="text-2xs text-muted-foreground tabular-nums">{{ fmtBytes(lv.size) }}</span>
                  <span v-if="lv2bd(lv).fstype" class="text-2xs font-mono px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground uppercase">{{ lv2bd(lv).fstype }}</span>
                  <span v-else class="text-2xs text-muted-foreground">unformatted</span>
                </div>
                <div v-if="lv2bd(lv).mountpoint" class="text-2xs font-mono text-muted-foreground mt-0.5">↳ {{ lv2bd(lv).mountpoint }}</div>
                <div v-if="lv2bd(lv).usageTotal > 0" class="mt-1.5 flex items-center gap-2">
                  <div class="w-24 h-0.5 bg-muted rounded-full overflow-hidden">
                    <div class="h-full rounded-full" :class="usageBarClass(usagePct(lv2bd(lv)))" :style="{ width: usagePct(lv2bd(lv)) + '%' }"/>
                  </div>
                  <span class="text-2xs text-muted-foreground tabular-nums">{{ fmtBytes(lv2bd(lv).usageFree) }} free</span>
                </div>
              </div>
              <!-- LV actions: revealed on hover, hidden by default -->
              <div v-if="!lv2bd(lv).isSystem" class="flex items-center gap-1 shrink-0 opacity-0 group-hover/lv:opacity-100 transition-opacity">
                <Button variant="outline" size="xs" v-if="!lv2bd(lv).mountpoint" @click="openFormat(lv2bd(lv))"
                  class="text-2xs text-muted-foreground hover:border-primary/50 hover:text-primary">Format</Button>
                <Button variant="outline" size="xs" v-if="lv2bd(lv).fstype && !lv2bd(lv).mountpoint" @click="openMount(lv2bd(lv))"
                  class="text-2xs text-muted-foreground hover:border-success/50 hover:text-success">Mount</Button>
                <Button variant="outline" size="xs" v-if="lv2bd(lv).mountpoint" @click="openUmount(lv2bd(lv))"
                  class="text-2xs text-muted-foreground hover:border-warning/50 hover:text-warning">Unmount</Button>
                <!-- Thin separator before destructive -->
                <div class="w-px h-3 bg-border mx-1"/>
                <Button variant="ghost" size="icon-xs" @click="removeLvDlg = { lv, busy: false, err: '' }"
                  title="Delete this logical volume"
                  class="text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10">
                  <Trash2Icon class="w-3.5 h-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Shared device dialogs (format / mount / unmount) -->
    <DeviceFormatWizard  ref="formatWiz" @done="refresh" @mount="d => mountDlg?.open(d)" />
    <DeviceMountDialog   ref="mountDlg"  @done="refresh" />
    <DeviceUnmountDialog ref="umountDlg" @done="refresh" />

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- LVM CREATE WIZARD                                                    -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Modal v-if="lvmWiz" panel-class="w-full max-w-md" :show-close="false" :prevent-close="!!lvmWiz.busy" @close="lvmWiz = null">

          <!-- Step indicator -->
          <div class="flex items-center border-b border-border">
            <div v-for="(label, i) in ['Select Devices', 'Configure', 'Confirm']" :key="i"
              :class="['flex-1 py-2.5 text-center text-2xs font-semibold transition-colors',
                lvmWiz.step === i + 1 ? 'text-purple-400 border-b-2 border-purple-400'
                : lvmWiz.step > i + 1  ? 'text-muted-foreground'
                : 'text-muted-foreground/50']"
            >{{ i + 1 }}. {{ label }}</div>
          </div>

          <!-- Step 1: Select devices -->
          <div v-if="lvmWiz.step === 1" class="p-5 space-y-3">
            <p class="text-sm text-foreground/80">
              Select one or more devices to become Physical Volumes (PVs). They will be combined into a Volume Group.
            </p>
            <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/5 border border-warning/20 text-2xs text-warning">
              <TriangleAlertIcon class="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              All data on the selected devices will be permanently destroyed.
            </div>
            <div v-if="eligibleForLvm.length === 0" class="py-6 text-center text-sm text-muted-foreground">
              No eligible devices available.<br>
              <span class="text-xs">Devices must be unmounted, not already a PV, and not a system disk.</span>
            </div>
            <div v-else class="space-y-1.5 max-h-52 overflow-y-auto pr-1">
              <label v-for="dev in eligibleForLvm" :key="dev.name"
                :class="['flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors',
                  lvmWiz.pvDevs.includes(dev.name)
                    ? 'border-purple-400 bg-purple-400/5'
                    : 'border-border hover:border-input']"
                @click="toggleLvmDev(dev.name)">
                <div :class="['w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                  lvmWiz.pvDevs.includes(dev.name) ? 'border-purple-400 bg-purple-400' : 'border-input']">
                  <CheckIcon v-if="lvmWiz.pvDevs.includes(dev.name)" class="w-2.5 h-2.5 text-white" aria-hidden="true" />
                </div>
                <div class="flex-1 min-w-0">
                  <span class="text-sm font-mono text-foreground">/dev/{{ dev.name }}</span>
                  <span v-if="dev.type === 'md'" class="ml-2 text-2xs px-1.5 py-0.5 rounded-sm bg-primary/10 text-primary">RAID</span>
                  <span v-else-if="dev.model" class="text-xs text-muted-foreground ml-2">{{ dev.model }}</span>
                </div>
                <span class="text-xs text-muted-foreground shrink-0">{{ fmtBytes(dev.size) }}</span>
              </label>
            </div>
            <div class="flex gap-2 pt-1">
              <Button variant="outline" @click="lvmWiz = null" class="flex-1 justify-center">Cancel</Button>
              <Button @click="lvmWiz.step = 2" :disabled="lvmWiz.pvDevs.length === 0"
                class="flex-1 justify-center">
                Next →
              </Button>
            </div>
          </div>

          <!-- Step 2: Configure VG + LV -->
          <div v-else-if="lvmWiz.step === 2" class="p-5 space-y-4">
            <p class="text-sm text-foreground/80">Name the Volume Group and its first Logical Volume.</p>
            <div>
              <label class="block text-xs font-medium text-foreground/80 mb-1.5">Volume Group name</label>
              <Input v-model="lvmWiz.vgName" type="text" placeholder="vg0"
                class="w-full px-3 py-2 text-sm font-mono"/>
              <p class="text-2xs text-muted-foreground mt-1">Letters, digits, underscores, hyphens. Must start with a letter.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-foreground/80 mb-1.5">First Logical Volume name</label>
              <Input v-model="lvmWiz.lvName" type="text" placeholder="lv0"
                class="w-full px-3 py-2 text-sm font-mono"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-foreground/80 mb-1.5">
                Size (GB) <span class="text-muted-foreground font-normal">(leave 0 to use all available space</span>
              </label>
              <Input v-model.number="lvmWiz.lvSizeGB" type="number" min="0" placeholder="0"
                class="w-full px-3 py-2 text-sm font-mono"/>
            </div>
            <div class="flex gap-2 pt-1">
              <Button variant="outline" @click="lvmWiz.step = 1" class="flex-1 justify-center">← Back</Button>
              <Button @click="lvmWiz.step = 3" :disabled="!lvmWiz.vgName || !lvmWiz.lvName"
                class="flex-1 justify-center">
                Next →
              </Button>
            </div>
          </div>

          <!-- Step 3: Confirm -->
          <div v-else-if="lvmWiz.step === 3" class="p-5 space-y-4">
            <div class="flex items-start gap-3 p-4 rounded-xl bg-warning/10 border border-warning/30">
              <TriangleAlertIcon class="w-5 h-5 text-warning mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <div class="font-semibold text-warning text-sm mb-1">All data on selected devices will be erased</div>
                <div class="text-xs text-warning/80">LVM will overwrite the beginning of each device to write PV headers.</div>
              </div>
            </div>
            <div class="space-y-1 text-xs text-muted-foreground">
              <div class="flex gap-2"><span class="w-20 text-foreground/80">Devices</span><span class="font-mono">{{ lvmWiz.pvDevs.join(', ') }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-foreground/80">VG name</span><span class="font-mono">{{ lvmWiz.vgName }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-foreground/80">LV name</span><span class="font-mono">{{ lvmWiz.lvName }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-foreground/80">LV size</span><span>{{ lvmWiz.lvSizeGB > 0 ? lvmWiz.lvSizeGB + ' GB' : 'All free space' }}</span></div>
            </div>
            <p v-if="lvmWiz.err" role="alert" class="px-1 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ lvmWiz.err }}</p>
            <div class="flex gap-2">
              <Button variant="outline" @click="lvmWiz.step = 2" :disabled="lvmWiz.busy" class="flex-1 justify-center">← Back</Button>
              <Button @click="doCreateLvm" :disabled="lvmWiz.busy"
                class="flex-1 justify-center">
                <span v-if="lvmWiz.busy">Creating…</span>
                <span v-else>Create volume group</span>
              </Button>
            </div>
          </div>

    </Modal>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- ADD LV DIALOG                                                        -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Modal v-if="addLvDlg" panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!addLvDlg.busy" @close="addLvDlg = null">
          <div class="px-5 py-4 border-b border-border">
            <h3 class="font-semibold text-foreground">Add logical volume</h3>
            <p class="text-xs text-muted-foreground mt-0.5">VG <span class="font-mono text-purple-400">{{ addLvDlg.vg.name }}</span> · {{ fmtBytes(addLvDlg.vg.free) }} free</p>
          </div>
          <div class="p-5 space-y-4">
            <div>
              <label class="block text-xs font-medium text-foreground/80 mb-1.5">Logical Volume name</label>
              <Input v-model="addLvDlg.lvName" type="text" placeholder="lv0"
                class="w-full px-3 py-2 text-sm font-mono"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-foreground/80 mb-1.5">
                Size (GB) <span class="text-muted-foreground font-normal">(0 = all remaining free space</span>
              </label>
              <Input v-model.number="addLvDlg.lvSizeGB" type="number" min="0" placeholder="0"
                class="w-full px-3 py-2 text-sm font-mono"/>
            </div>
            <p v-if="addLvDlg.err" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ addLvDlg.err }}</p>
            <div class="flex gap-2 pt-1">
              <Button variant="outline" @click="addLvDlg = null" class="flex-1 justify-center">Cancel</Button>
              <Button @click="doAddLv" :disabled="!addLvDlg.lvName || addLvDlg.busy"
                class="flex-1 justify-center">
                <span v-if="addLvDlg.busy">Creating…</span>
                <span v-else>Create logical volume</span>
              </Button>
            </div>
          </div>
    </Modal>

    <!-- Remove LV -->
    <ConfirmDestroyDialog
      v-if="removeLvDlg"
      title="Delete Logical Volume"
      :confirm-word="removeLvDlg.lv.name"
      action-label="Delete LV"
      busy-label="Deleting…"
      :busy="removeLvDlg.busy"
      :error="removeLvDlg.err"
      @confirm="doRemoveLv"
      @close="removeLvDlg = null"
    >
      <template #warning>All data on <span class="font-mono font-bold">{{ removeLvDlg.lv.path }}</span> will be permanently destroyed.</template>
      <template #details>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">LV</span><span class="font-mono">{{ removeLvDlg.lv.path }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">VG</span><span class="font-mono">{{ removeLvDlg.lv.vgName }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">Size</span><span>{{ fmtBytes(removeLvDlg.lv.size) }}</span></div>
      </template>
    </ConfirmDestroyDialog>

    <!-- Remove VG -->
    <ConfirmDestroyDialog
      v-if="removeVgDlg"
      title="Remove Volume Group"
      subtitle="This will delete the VG and all its Logical Volumes."
      :confirm-word="removeVgDlg.vg.name"
      action-label="Remove VG"
      busy-label="Removing…"
      :busy="removeVgDlg.busy"
      :error="removeVgDlg.err"
      @confirm="doRemoveVg"
      @close="removeVgDlg = null"
    >
      <template #warning>Removing <span class="font-mono font-bold">{{ removeVgDlg.vg.name }}</span> will destroy all {{ removeVgDlg.vg.lvCount }} Logical Volume(s) and their data.</template>
      <template #details>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">VG</span><span class="font-mono">{{ removeVgDlg.vg.name }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">Size</span><span>{{ fmtBytes(removeVgDlg.vg.size) }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">PVs</span><span>{{ removeVgDlg.vg.pvCount }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">LVs</span><span>{{ removeVgDlg.vg.lvCount }}</span></div>
      </template>
    </ConfirmDestroyDialog>
  </div>
</template>
