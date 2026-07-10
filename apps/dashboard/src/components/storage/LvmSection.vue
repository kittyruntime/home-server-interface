<script setup lang="ts">
import { ref, computed } from 'vue'
import { useStorageData, fmtBytes, usagePct, usageBarClass, lvToBlockDev, criticalMountPoints, type BlockDev, type LvmVG, type LvmLV } from '../../composables/useStorageData'
import { trpc } from '../../lib/trpc'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import DeviceFormatWizard from './dialogs/DeviceFormatWizard.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'
import ConfirmDestroyDialog from './dialogs/ConfirmDestroyDialog.vue'
import Modal from '../ui/Modal.vue'

const { loading, error, devices, raids, lvmPVs, lvmVGs, lvmLVs, refresh } = useStorageData()

// ── Helpers ───────────────────────────────────────────────────────────────────

// Wrapper so template can call without passing devices each time
function lv2bd(lv: LvmLV): BlockDev {
  return lvToBlockDev(lv, devices.value)
}

// ── Computed ──────────────────────────────────────────────────────────────────

function makeRaidChecker(inRaid: Set<string>, mdNames: Set<string>) {
  function committedToRaid(dev: BlockDev): boolean {
    if (inRaid.has(dev.name) || mdNames.has(dev.name)) return true
    return (dev.children ?? []).some(committedToRaid)
  }
  return committedToRaid
}

function allDevices(): BlockDev[] {
  const out: BlockDev[] = []
  function walk(d: BlockDev) { out.push(d); d.children?.forEach(walk) }
  devices.value.forEach(walk)
  return out
}

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
    await trpc.system.createPv.mutate({ devices: w.pvDevs })
    await trpc.system.createVg.mutate({ name: w.vgName, devices: w.pvDevs })
    const sizeBytes = w.lvSizeGB > 0 ? Math.floor(w.lvSizeGB * 1024 ** 3) : 0
    await trpc.system.createLv.mutate({ vgName: w.vgName, lvName: w.lvName, sizeBytes })
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
    await trpc.system.createLv.mutate({ vgName: d.vg.name, lvName: d.lvName, sizeBytes })
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
    await trpc.system.removeLv.mutate({ vgName: d.lv.vgName, lvName: d.lv.name })
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
    await trpc.system.removeVg.mutate({ vgName: d.vg.name })
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

const openMenu = ref<string | null>(null)
</script>

<template>
  <div>
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">LVM</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Physical volumes, volume groups et logical volumes.</p>
      </div>
      <div class="flex items-center gap-2">
        <button @click="openLvmWizard"
          class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
          Create VG
        </button>
        <button @click="refresh" :disabled="loading" title="Refresh" class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>
      </div>
    </div>

    <div v-if="loading && !lvmVGs.length" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6"><LoadingSpinner /> Loading…</div>
    <div v-else-if="error" class="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{{ error }}</div>

    <div v-if="openMenu" class="fixed inset-0 z-20" @click="openMenu = null"/>

    <!-- VG list -->
    <div class="flex items-center justify-between mb-3">
      <span v-if="lvmVGs.length" class="text-[10px] px-1.5 py-0.5 rounded-sm bg-[var(--c-surface-deep)] text-[var(--c-text-3)] tabular-nums">{{ lvmVGs.length }} volume group{{ lvmVGs.length !== 1 ? 's' : '' }}</span>
    </div>

    <div v-if="!loading && lvmVGs.length === 0" class="rounded-xl border border-dashed border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-6 text-center text-sm text-[var(--c-text-3)]">
      No LVM volume groups. Create one to get resizable logical volumes from one or more physical drives.
    </div>

    <div v-else class="space-y-3">
      <div v-for="vg in lvmVGs" :key="vg.name"
        class="rounded-xl border bg-[var(--c-surface)] overflow-hidden flex"
        :class="isSystemVg(vg.name) ? 'border-warning/20' : 'border-[var(--c-border)]'">
        <!-- Left stripe -->
        <div class="w-0.5 shrink-0" :class="isSystemVg(vg.name) ? 'bg-warning/60' : 'bg-purple-500/50'"/>
        <div class="flex-1 min-w-0">
          <!-- VG header -->
          <div class="flex items-center gap-3 px-4 py-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-sm font-semibold text-[var(--c-text-1)]">{{ vg.name }}</span>
                <span class="text-[11px] text-[var(--c-text-3)]">{{ fmtBytes(vg.size) }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded-sm bg-purple-500/10 text-purple-400 shrink-0">{{ vg.pvCount }} PV · {{ vg.lvCount }} LV</span>
                <span v-if="isSystemVg(vg.name)" class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm bg-warning/10 text-warning border border-warning/20">
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
                  class="absolute right-0 top-full mt-1.5 bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl shadow-[var(--shadow-md)] overflow-hidden min-w-[176px]">
                  <div class="px-3 pt-2.5 pb-1.5 border-b border-[var(--c-border)]">
                    <p class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Danger zone</p>
                  </div>
                  <button @click="removeVgDlg = { vg, busy: false, err: '' }; openMenu = null"
                    class="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-danger hover:bg-danger/10 transition-colors text-left">
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
                :class="lv2bd(lv).isSystem ? 'bg-warning/70' : lv2bd(lv).mountpoint ? 'bg-success/70' : 'bg-purple-400/40'"/>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="font-mono text-xs text-[var(--c-text-2)]">{{ lv.path }}</span>
                  <span class="text-[10px] text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(lv.size) }}</span>
                  <span v-if="lv2bd(lv).fstype" class="text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-[var(--c-surface-deep)] text-[var(--c-text-3)] uppercase">{{ lv2bd(lv).fstype }}</span>
                  <span v-else class="text-[10px] italic text-[var(--c-text-3)]">unformatted</span>
                </div>
                <div v-if="lv2bd(lv).mountpoint" class="text-[10px] font-mono text-[var(--c-text-3)] mt-0.5">↳ {{ lv2bd(lv).mountpoint }}</div>
                <div v-if="lv2bd(lv).usageTotal > 0" class="mt-1.5 flex items-center gap-2">
                  <div class="w-24 h-0.5 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                    <div class="h-full rounded-full" :class="usageBarClass(usagePct(lv2bd(lv)))" :style="{ width: usagePct(lv2bd(lv)) + '%' }"/>
                  </div>
                  <span class="text-[10px] text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(lv2bd(lv).usageFree) }} free</span>
                </div>
              </div>
              <!-- LV actions — revealed on hover, hidden by default -->
              <div v-if="!lv2bd(lv).isSystem" class="flex items-center gap-1 shrink-0 opacity-0 group-hover/lv:opacity-100 transition-opacity">
                <button v-if="!lv2bd(lv).mountpoint" @click="openFormat(lv2bd(lv))"
                  class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">Format</button>
                <button v-if="lv2bd(lv).fstype && !lv2bd(lv).mountpoint" @click="openMount(lv2bd(lv))"
                  class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-success/50 hover:text-success transition-colors">Mount</button>
                <button v-if="lv2bd(lv).mountpoint" @click="openUmount(lv2bd(lv))"
                  class="text-[11px] px-2 py-0.5 rounded-sm border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-warning/50 hover:text-warning transition-colors">Unmount</button>
                <!-- Thin separator before destructive -->
                <div class="w-px h-3 bg-[var(--c-border)] mx-1"/>
                <button @click="removeLvDlg = { lv, busy: false, err: '' }"
                  title="Delete this logical volume"
                  class="w-6 h-6 flex items-center justify-center rounded-sm text-[var(--c-text-3)]/40 hover:text-danger hover:bg-danger/10 transition-colors">
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

    <!-- Shared device dialogs (format / mount / unmount) -->
    <DeviceFormatWizard  ref="formatWiz" @done="refresh" />
    <DeviceMountDialog   ref="mountDlg"  @done="refresh" />
    <DeviceUnmountDialog ref="umountDlg" @done="refresh" />

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- LVM CREATE WIZARD                                                    -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Modal v-if="lvmWiz" panel-class="w-full max-w-md" :show-close="false" :prevent-close="!!lvmWiz.busy" @close="lvmWiz = null">

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
            <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/5 border border-warning/20 text-[11px] text-warning">
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
                  <span v-if="dev.type === 'md'" class="ml-2 text-[10px] px-1.5 py-0.5 rounded-sm bg-[var(--c-accent)]/10 text-[var(--c-accent)]">RAID</span>
                  <span v-else-if="dev.model" class="text-xs text-[var(--c-text-3)] ml-2">{{ dev.model }}</span>
                </div>
                <span class="text-xs text-[var(--c-text-3)] shrink-0">{{ fmtBytes(dev.size) }}</span>
              </label>
            </div>
            <div class="flex gap-2 pt-1">
              <button @click="lvmWiz = null" class="btn btn-outline flex-1 justify-center">Cancel</button>
              <button @click="lvmWiz.step = 2" :disabled="lvmWiz.pvDevs.length === 0"
                class="btn btn-primary flex-1 justify-center">
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
              <button @click="lvmWiz.step = 1" class="btn btn-outline flex-1 justify-center">← Back</button>
              <button @click="lvmWiz.step = 3" :disabled="!lvmWiz.vgName || !lvmWiz.lvName"
                class="btn btn-primary flex-1 justify-center">
                Next →
              </button>
            </div>
          </div>

          <!-- Step 3: Confirm -->
          <div v-else-if="lvmWiz.step === 3" class="p-5 space-y-4">
            <div class="flex items-start gap-3 p-4 rounded-xl bg-warning/10 border border-warning/30">
              <svg class="w-5 h-5 text-warning mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <div>
                <div class="font-semibold text-warning text-sm mb-1">All data on selected devices will be erased</div>
                <div class="text-xs text-warning/80">LVM will overwrite the beginning of each device to write PV headers.</div>
              </div>
            </div>
            <div class="space-y-1 text-xs text-[var(--c-text-3)]">
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Devices</span><span class="font-mono">{{ lvmWiz.pvDevs.join(', ') }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">VG name</span><span class="font-mono">{{ lvmWiz.vgName }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">LV name</span><span class="font-mono">{{ lvmWiz.lvName }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">LV size</span><span>{{ lvmWiz.lvSizeGB > 0 ? lvmWiz.lvSizeGB + ' GB' : 'All free space' }}</span></div>
            </div>
            <div v-if="lvmWiz.err" class="text-xs text-danger px-1">{{ lvmWiz.err }}</div>
            <div class="flex gap-2">
              <button @click="lvmWiz.step = 2" :disabled="lvmWiz.busy" class="btn btn-outline flex-1 justify-center">← Back</button>
              <button @click="doCreateLvm" :disabled="lvmWiz.busy"
                class="btn btn-primary flex-1 justify-center">
                <span v-if="lvmWiz.busy">Creating…</span>
                <span v-else>Create LVM</span>
              </button>
            </div>
          </div>

    </Modal>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- ADD LV DIALOG                                                        -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Modal v-if="addLvDlg" panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!addLvDlg.busy" @close="addLvDlg = null">
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
            <div v-if="addLvDlg.err" class="text-xs text-danger">{{ addLvDlg.err }}</div>
            <div class="flex gap-2 pt-1">
              <button @click="addLvDlg = null" class="btn btn-outline flex-1 justify-center">Cancel</button>
              <button @click="doAddLv" :disabled="!addLvDlg.lvName || addLvDlg.busy"
                class="btn btn-primary flex-1 justify-center">
                <span v-if="addLvDlg.busy">Creating…</span>
                <span v-else>Create LV</span>
              </button>
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
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">LV</span><span class="font-mono">{{ removeLvDlg.lv.path }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">VG</span><span class="font-mono">{{ removeLvDlg.lv.vgName }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(removeLvDlg.lv.size) }}</span></div>
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
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">VG</span><span class="font-mono">{{ removeVgDlg.vg.name }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(removeVgDlg.vg.size) }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">PVs</span><span>{{ removeVgDlg.vg.pvCount }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">LVs</span><span>{{ removeVgDlg.vg.lvCount }}</span></div>
      </template>
    </ConfirmDestroyDialog>
  </div>
</template>
