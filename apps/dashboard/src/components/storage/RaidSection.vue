<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Card } from '@/components/ui/card'
import { CheckIcon, EllipsisVerticalIcon, ChevronRightIcon, PlusIcon, RefreshCwIcon, Trash2Icon, TriangleAlertIcon, ZapIcon } from '@lucide/vue'
import type { StorageLocation } from '../../lib/storage-nav'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import LoadingState from '../ui/LoadingState.vue'
import { applyPlanned } from '../../lib/plan'
import { ref, computed, watch, onUnmounted } from 'vue'
import {
  useStorageData, fmtBytes, usagePct, usageBarClass,
  raidLevelLabel, raidDescription, isRaidHealthy, claimableDevices,
  type BlockDev, type RaidArray, type RaidMember,
} from './store'
import { raidCapacity, remainingFaultTolerance } from './raid-capacity'
import { useHostTools } from './tools'
import { useToast } from '../../lib/toast'
import DeviceFormatWizard from './dialogs/DeviceFormatWizard.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'
import ConfirmDestroyDialog from './dialogs/ConfirmDestroyDialog.vue'
import Modal from '../ui/Modal.vue'
import RaidLevelVisual from './RaidLevelVisual.vue'
import Hint from '../ui/Hint.vue'
import ImportFound from './ImportFound.vue'
import { Button } from '@/components/ui/button'
import { Item } from '@/components/ui/item'
import Tip from '../ui/Tip.vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

// `preselect`: whole disks picked in Devices; opens the create wizard with them.
// `only`: show just this array / volume group (its page, #40), without the
// section header and create entry points.
const props = defineProps<{ preselect?: string[]; only?: string }>()
const emit = defineEmits<{ navigate: [target: 'disks' | 'lvm' | StorageLocation]; preselected: [] }>()

const { loading, error, devices, raids, lvmPVs, refresh } = useStorageData()
const { isMissing } = useHostTools()
const toast = useToast()

// ── Member management (replace a failed disk) ────────────────────────────────

function membersOf(r: RaidArray): RaidMember[] {
  return r.members ?? r.devices.map(name => ({ name, role: 'active' as const }))
}

function memberDev(name: string): BlockDev | undefined {
  let found: BlockDev | undefined
  function walk(d: BlockDev) { if (d.name === name) found = d; d.children?.forEach(walk) }
  devices.value.forEach(walk)
  return found
}

// "WDC WD40EFRX · serial WD-WCC4E1234567": what to look for on the disk label.
function memberIdentity(name: string): string {
  const d = memberDev(name)
  // A partition's model/serial are the parent disk's.
  const disk = d?.model || d?.serial ? d : devices.value.find(x => x.children?.some(c => c.name === name))
  return [disk?.model, disk?.serial ? `serial ${disk.serial}` : ''].filter(Boolean).join(' · ')
}

// Slots with no device at all (a member that was removed or vanished).
function emptySlots(r: RaidArray): number {
  const present = membersOf(r).filter(m => m.role !== 'spare').length
  return Math.max(0, r.total - present)
}

function replacementCandidates(r: RaidArray): BlockDev[] {
  const sizes = membersOf(r).map(m => memberSize(m.name)).filter(n => n > 0)
  const needed = sizes.length ? Math.min(...sizes) : 0
  return claimableDevices(devices.value).filter(d => d.size >= needed)
}

const memberBusy = ref<string | null>(null)
const addPicker = ref<string | null>(null) // array name whose picker is open

async function runMemberOp(r: RaidArray, device: string, op: 'fail' | 'remove' | 'add') {
  memberBusy.value = `${r.name}:${device}`
  try {
    const title = op === 'fail' ? `Mark /dev/${device} as failed in /dev/${r.name}`
      : op === 'remove' ? `Remove /dev/${device} from /dev/${r.name}`
      : `Add /dev/${device} to /dev/${r.name}`
    const actionLabel = op === 'fail' ? 'Mark as failed' : op === 'remove' ? 'Remove' : `Add /dev/${device}`
    await applyPlanned(`raid.${op}`, { name: r.name, device }, { title, actionLabel, danger: op === 'fail' })
    addPicker.value = null
    await refresh()
  } catch (e: any) {
    // An empty message means the plan was cancelled: nothing to report.
    if (e?.message !== '') toast.error(e?.message ?? t('uis.storage.RaidSection.couldNotDev', { p0: op, p1: device }))
  } finally {
    memberBusy.value = null
  }
}

// The plan dialog is the confirmation for member changes.
async function failMember(r: RaidArray, m: RaidMember) {
  await runMemberOp(r, m.name, 'fail')
}

async function removeMember(r: RaidArray, m: RaidMember) {
  await runMemberOp(r, m.name, 'remove')
}

async function addMember(r: RaidArray, d: BlockDev) {
  await runMemberOp(r, d.name, 'add')
}

function syncLabel(r: RaidArray): string {
  if (r.resyncPercent == null) return r.state
  const what = r.syncAction === 'recovery' ? 'Rebuilding' : r.syncAction === 'check' ? 'Checking' : r.syncAction === 'reshape' ? 'Reshaping' : 'Syncing'
  return `${what}: ${r.resyncPercent.toFixed(1)}%`
}

// Refresh while an array rebuilds so progress moves without a reload.
let syncTimer: ReturnType<typeof setInterval> | null = null
watch(() => raids.value.some(r => r.resyncPercent != null), syncing => {
  if (syncing && !syncTimer) syncTimer = setInterval(() => { void refresh() }, 5_000)
  if (!syncing && syncTimer) { clearInterval(syncTimer); syncTimer = null }
}, { immediate: true })
onUnmounted(() => { if (syncTimer) clearInterval(syncTimer) })

// ── Computed ──────────────────────────────────────────────────────────────────

const raidBlockDevs = computed(() =>
  devices.value.filter(d => d.type === 'md' || raids.value.find(r => r.name === d.name))
)

function raidBlockDev(name: string): BlockDev | undefined {
  return raidBlockDevs.value.find(d => d.name === name)
}

// Is this RAID array used as an LVM PV?
function raidPvVg(raidName: string): string | undefined {
  return lvmPVs.value.find(p => p.name === `/dev/${raidName}`)?.vgName
}

// Eligible for RAID creation: free disks/partitions (worker usage)
const eligibleForRaid = computed<BlockDev[]>(() => claimableDevices(devices.value))

// ── Format wizard ─────────────────────────────────────────────────────────────

// Device format/mount/unmount dialogs are shared components (see ./dialogs);
// these thin wrappers open them via template refs and refresh on success.
const formatWiz = ref<InstanceType<typeof DeviceFormatWizard> | null>(null)
const mountDlg  = ref<InstanceType<typeof DeviceMountDialog>  | null>(null)
const umountDlg = ref<InstanceType<typeof DeviceUnmountDialog> | null>(null)
function openFormat(dev: BlockDev) { formatWiz.value?.open(dev) }
function openMount(dev: BlockDev)  { mountDlg.value?.open(dev) }
function openUmount(dev: BlockDev) { umountDlg.value?.open(dev) }

// ── Create RAID wizard ────────────────────────────────────────────────────────

const RAID_LEVELS = [
  {
    level: 0, name: 'RAID 0', sub: 'Striping', minDev: 2,
    redundancy: 'None',
    desc: 'All drives are combined into one large volume. Maximum capacity and speed.',
    danger: 'No redundancy: if ANY single drive fails, ALL data on the array is lost permanently.',
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

function openRaidWizard(devs: string[] = []) {
  raidWiz.value = { step: 1, level: 1, devs: [...devs], name: nextMdName(), confirm: '', busy: false, err: '' }
}

watch(() => props.preselect, devs => {
  if (!devs?.length) return
  openRaidWizard(devs)
  emit('preselected')
}, { immediate: true })

const selectedRaidLevel = computed(() =>
  RAID_LEVELS.find(l => l.level === raidWiz.value?.level) ?? RAID_LEVELS[1]!
)

function toggleRaidDev(name: string) {
  if (!raidWiz.value) return
  const idx = raidWiz.value.devs.indexOf(name)
  if (idx >= 0) raidWiz.value.devs.splice(idx, 1)
  else raidWiz.value.devs.push(name)
}

// Live capacity of the selected drives, instead of a generic formula.
const wizardCapacity = computed(() => {
  const w = raidWiz.value
  if (!w) return null
  const picked = w.devs.map(n => eligibleForRaid.value.find(d => d.name === n)).filter((d): d is BlockDev => !!d)
  const cap = raidCapacity(w.level, picked.map(d => d.size))
  const waste = picked
    .map((d, i) => ({ name: d.name, bytes: cap.wasted[i] ?? 0 }))
    .filter(x => x.bytes > 0)
  return { cap, waste }
})

function toleranceText(n: number, max: number): string {
  if (n === 0) return t('uis.storage.RaidSection.noDriveFailureTolerated')
  const base = `survives ${n} drive failure${n > 1 ? 's' : ''}`
  return max > n ? `${base} (up to ${max} if they hit different mirrors)` : base
}

// Usable vs raw size and remaining tolerance of an existing array.
function arrayCapacityLine(r: RaidArray): string {
  const md = raidBlockDev(r.name)
  const memberSizes = r.devices.map(n => memberSize(n)).filter(s => s > 0)
  const raw = memberSizes.reduce((a, b) => a + b, 0)
  const usable = md?.size ?? raidCapacity(r.level, memberSizes).usable
  const parts: string[] = []
  if (usable > 0) parts.push(raw > 0 ? `${fmtBytes(usable)} usable of ${fmtBytes(raw)} raw (${Math.round(usable / raw * 100)}%)` : `${fmtBytes(usable)} usable`)
  const left = remainingFaultTolerance(r.level, r.total, r.active)
  parts.push(left === 0 ? 'no failure tolerated right now' : `can lose ${left} more drive${left > 1 ? 's' : ''}`)
  return parts.join(' · ')
}

function memberSize(name: string): number {
  let size = 0
  function walk(d: BlockDev) { if (d.name === name) size = d.size; d.children?.forEach(walk) }
  devices.value.forEach(walk)
  return size
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
    await applyPlanned('raid.create', { name: w.name, level: w.level, devices: w.devs },
      { title: t('uis.storage.RaidSection.createRaidDev', { p0: w.level, p1: w.name }), actionLabel: t('uis.storage.RaidSection.createDev', { p0: w.name }) })
    raidWiz.value = null
    await refresh()
  } catch (e: any) {
    w.err = e?.message ?? t('uis.storage.RaidSection.raidCreationFailed')
  } finally {
    if (raidWiz.value) w.busy = false
  }
}

// ── Destroy RAID ──────────────────────────────────────────────────────────────

const destroyDlg = ref<{
  raid:    RaidArray
  busy:    boolean
  err:     string
} | null>(null)

function openDestroy(raid: RaidArray) {
  destroyDlg.value = { raid, busy: false, err: '' }
}

async function doDestroyRaid() {
  if (!destroyDlg.value) return
  const d = destroyDlg.value
  d.busy = true
  d.err  = ''
  try {
    const res = await applyPlanned('raid.stop', { name: d.raid.name },
      { title: t('uis.storage.RaidSection.deleteRaidDev', { p0: d.raid.name }), actionLabel: t('uis.storage.RaidSection.deleteDev', { p0: d.raid.name }) })
    // The array is gone; anything left behind (a signature that could not be
    // wiped, a config file that could not be updated) is reported, not fatal.
    for (const w of res.warnings ?? []) toast.error(w)
    destroyDlg.value = null
    await refresh()
  } catch (e: any) {
    d.err = e?.message ?? t('uis.storage.RaidSection.failedToDestroyRaid')
  } finally {
    if (destroyDlg.value) d.busy = false
  }
}


const shown = computed(() => props.only ? raids.value.filter(x => x.name === props.only) : raids.value)
</script>

<template>
  <div>
    <div v-if="!only" class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-foreground">{{ t('ui.storage.RaidSection.arrays') }}</h2>
        <p class="text-sm text-muted-foreground mt-0.5">{{ t('ui.storage.RaidSection.manageSoftwareRaidArraysMdadm') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Tip :text="isMissing('mdadm') ? 'mdadm is not installed: sudo apt install mdadm' : undefined" wrap>
          <Button variant="outline" size="sm" @click="openRaidWizard()" :disabled="isMissing('mdadm')">
            <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
            {{ t('ui.storage.RaidSection.createRaid') }}
          </Button>
        </Tip>
        <Button variant="ghost" size="icon-sm" @click="refresh" :disabled="loading" :tooltip="t('ui.storage.RaidSection.refresh')" :aria-label="t('ui.storage.RaidSection.refresh')" class="text-muted-foreground hover:text-foreground">
          <LoadingSpinner v-if="loading" class="text-base" />
          <RefreshCwIcon v-else class="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>
    </div>

    <ImportFound v-if="!only" kind="raid" @imported="refresh" />

    <LoadingState v-if="loading && !raids.length" variant="block" />
    <Alert variant="destructive" v-else-if="error" class="mt-4"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <!-- RAID arrays list -->
    <div v-if="!only" class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <span v-if="raids.length" class="text-2xs px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground tabular-nums">{{ raids.length }} array{{ raids.length !== 1 ? 's' : '' }}</span>
      </div>
    </div>

    <div v-if="!only && raids.length === 0 && !loading" class="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
      {{ t('ui.storage.RaidSection.noRaidArraysConfiguredCreate') }}
    </div>

    <div v-else class="space-y-3">
      <Card v-for="r in shown" :key="r.name"
        class="gap-0 py-0 shadow-none overflow-hidden flex flex-row"
        :class="isRaidHealthy(r) ? 'border-border' : 'border-destructive/20'">
        <!-- Left accent stripe -->
        <div class="w-0.5 shrink-0" :class="isRaidHealthy(r) ? 'bg-primary/50' : 'bg-destructive'"/>
        <div class="flex-1 min-w-0">
          <!-- Header -->
          <div class="flex items-center gap-3 px-4 pt-3.5 pb-2">
            <span class="text-2xs font-bold px-2 py-0.5 rounded-sm tracking-wide shrink-0"
              :class="isRaidHealthy(r) ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'">
              {{ raidLevelLabel(r.level) }}
            </span>
            <Button variant="link" v-if="!only" class="h-auto p-0 font-mono text-foreground" @click="emit('navigate', { kind: 'array', name: r.name })">/dev/{{ r.name }}</Button>
            <span v-else class="font-mono text-sm text-foreground">/dev/{{ r.name }}</span>
            <div class="ml-auto flex items-center gap-3 shrink-0">
              <span class="text-2xs text-muted-foreground">{{ r.active }}/{{ r.total }} drives</span>
              <span class="inline-flex items-center gap-1.5 text-2xs font-medium" :class="isRaidHealthy(r) ? 'text-success' : 'text-destructive'">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="isRaidHealthy(r) ? 'bg-success' : 'bg-destructive animate-pulse'"/>
                {{ isRaidHealthy(r) ? 'Healthy' : syncLabel(r) }}
              </span>
              <!-- Cross-nav: RAID used as LVM PV -->
              <Button variant="outline" size="xs" v-if="raidPvVg(r.name)" @click="emit('navigate', { kind: 'vg', name: raidPvVg(r.name)! })"
                class="text-2xs bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20">
                {{ t('uip.storage.RaidSection.lvm', { p0: raidPvVg(r.name) }) }}
              </Button>
              <!-- ⋯ menu -->
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" class="text-muted-foreground" :aria-label="t('ui.storage.RaidSection.arrayActions')">
                    <EllipsisVerticalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="min-w-[176px]">
                  <DropdownMenuLabel class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.storage.RaidSection.dangerZone') }}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" @select="openDestroy(r)">
                    <Trash2Icon />
                    {{ t('ui.storage.RaidSection.destroyArray') }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <p v-if="raidDescription(r.level)" class="text-2xs text-muted-foreground px-4 pb-1">{{ raidDescription(r.level) }}</p>
          <p class="text-2xs text-foreground/80 px-4 pb-3">{{ arrayCapacityLine(r) }}</p>
          <!-- Built from: member devices, completing the disk → RAID chain started in Devices -->
          <p class="text-2xs text-muted-foreground px-4 pb-3 font-mono">← {{ r.devices.map(d => '/dev/' + d).join(' + ') }}</p>

          <!-- Drive bay -->
          <div class="px-4 pb-4">
            <div class="flex items-center gap-1.5 flex-wrap">
              <template v-for="(dev, idx) in r.devices" :key="dev">
                <div class="flex flex-col items-center gap-1.5">
                  <div class="relative rounded-lg border transition-colors"
                    :class="membersOf(r)[idx]?.role !== 'faulty' ? 'border-input bg-muted' : 'border-destructive/40 bg-destructive/5'">
                    <svg viewBox="0 0 52 68" class="w-12 h-16">
                      <rect x="3" y="3" width="46" height="62" rx="5"
                        :fill="membersOf(r)[idx]?.role !== 'faulty' ? 'var(--muted)' : 'color-mix(in srgb, var(--destructive) 6%, transparent)'"
                        :stroke="membersOf(r)[idx]?.role !== 'faulty' ? 'var(--input)' : 'color-mix(in srgb, var(--destructive) 50%, transparent)'" stroke-width="1.5"/>
                      <circle cx="9" cy="10" r="2" fill="var(--card)" opacity="0.8"/>
                      <circle cx="43" cy="10" r="2" fill="var(--card)" opacity="0.8"/>
                      <circle cx="9" cy="58" r="2" fill="var(--card)" opacity="0.8"/>
                      <circle cx="43" cy="58" r="2" fill="var(--card)" opacity="0.8"/>
                      <circle cx="26" cy="32" r="12" fill="none" :stroke="membersOf(r)[idx]?.role !== 'faulty' ? 'var(--primary)' : 'color-mix(in srgb, var(--destructive) 50%, transparent)'" stroke-width="1" opacity="0.35"/>
                      <circle cx="26" cy="32" r="6" fill="none" :stroke="membersOf(r)[idx]?.role !== 'faulty' ? 'var(--primary)' : 'color-mix(in srgb, var(--destructive) 50%, transparent)'" stroke-width="1" opacity="0.35"/>
                      <line x1="26" y1="32" x2="35" y2="21" :stroke="membersOf(r)[idx]?.role !== 'faulty' ? 'var(--primary)' : 'color-mix(in srgb, var(--destructive) 60%, transparent)'" stroke-width="1.5" opacity="0.5" stroke-linecap="round"/>
                      <circle cx="26" cy="32" r="2.5" :fill="membersOf(r)[idx]?.role !== 'faulty' ? 'var(--primary)' : 'color-mix(in srgb, var(--destructive) 70%, transparent)'" opacity="0.8"/>
                      <circle cx="40" cy="50" r="2" :fill="membersOf(r)[idx]?.role !== 'faulty' ? 'var(--success)' : 'var(--destructive)'" opacity="0.9"/>
                      <rect x="15" y="60" width="22" height="2.5" rx="1" fill="var(--muted-foreground)" opacity="0.25"/>
                    </svg>
                  </div>
                  <Button variant="link" @click="emit('navigate', { kind: 'disk', name: dev })"
                    class="h-auto p-0 text-2xs font-mono"
                    :class="membersOf(r)[idx]?.role !== 'faulty' ? 'text-muted-foreground hover:text-foreground' : 'text-destructive'">
                    /dev/{{ dev }}
                  </Button>
                </div>
                <ChevronRightIcon v-if="idx < r.devices.length - 1" class="w-3.5 h-3.5 text-muted-foreground self-center mb-5 shrink-0" aria-hidden="true" />
              </template>
              <div class="flex items-center self-center mb-5 gap-2 ml-1">
                <ZapIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                <div>
                  <div class="text-2xs font-semibold text-foreground/80">{{ raidLevelLabel(r.level) }}</div>
                  <div class="text-2xs text-muted-foreground font-mono">{{ raidBlockDev(r.name)?.mountpoint || (raidPvVg(r.name) ? `LVM ${raidPvVg(r.name)}` : 'not mounted') }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Disks: identify, fail, remove, add a replacement -->
          <div class="px-4 pb-4">
            <div v-if="r.resyncPercent != null" class="mb-3">
              <div class="flex justify-between text-2xs text-foreground/80 mb-1">
                <span>{{ syncLabel(r) }}</span>
                <span v-if="r.syncAction === 'recovery'" class="text-muted-foreground">{{ t('ui.storage.RaidSection.redundancyReturnsWhenItFinishes') }}</span>
              </div>
              <Progress class="h-1.5 rounded-full bg-muted" :model-value="r.resyncPercent" indicator-class="bg-primary transition-all" />
            </div>
            <div class="rounded-lg border border-border divide-y divide-border">
              <div v-for="m in membersOf(r)" :key="m.name" class="flex items-center gap-3 px-3 py-2">
                <span class="text-2xs font-semibold uppercase px-1.5 py-0.5 rounded-sm shrink-0"
                  :class="m.role === 'faulty' ? 'bg-destructive/10 text-destructive' : m.role === 'spare' ? 'bg-info/10 text-info' : m.role === 'rebuilding' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'">
                  {{ m.role === 'faulty' ? 'Failed' : m.role === 'spare' ? 'Spare' : m.role === 'rebuilding' ? 'Rebuilding' : 'Active' }}
                </span>
                <div class="min-w-0 flex-1">
                  <span class="font-mono text-xs text-foreground">/dev/{{ m.name }}</span>
                  <span v-if="memberSize(m.name)" class="text-2xs text-muted-foreground ml-2">{{ fmtBytes(memberSize(m.name)) }}</span>
                  <p v-if="memberIdentity(m.name)" class="text-2xs text-muted-foreground truncate">{{ memberIdentity(m.name) }}</p>
                </div>
                <Button variant="ghost" size="xs" v-if="m.role === 'active' && !raidBlockDev(r.name)?.isSystem" type="button" class="shrink-0"
                  :disabled="memberBusy !== null" @click="failMember(r, m)">{{ t('ui.storage.RaidSection.markAsFailed') }}</Button>
                <Button variant="outline" size="xs" v-else-if="m.role === 'faulty' || m.role === 'spare'" type="button" class="shrink-0"
                  :disabled="memberBusy !== null" @click="removeMember(r, m)">
                  {{ memberBusy === `${r.name}:${m.name}` ? 'Removing…' : 'Remove' }}
                </Button>
              </div>
              <div v-if="emptySlots(r) > 0" class="px-3 py-2 text-2xs text-destructive">
                {{ t('uip.storage.RaidSection.emptySlotAddAReplacement', { p0: emptySlots(r), p1: emptySlots(r) > 1 ? 's' : '' }) }}
              </div>
            </div>

            <div class="mt-2">
              <Button variant="ghost" size="xs" v-if="addPicker !== r.name" type="button" :disabled="memberBusy !== null"
                @click="addPicker = r.name">{{ t('ui.storage.RaidSection.addADisk') }}</Button>
              <div v-else class="rounded-lg border border-border p-2 space-y-1">
                <p class="text-2xs text-muted-foreground px-1">{{ t('ui.storage.RaidSection.freeDisksAtLeastAs') }}</p>
                <p v-if="!replacementCandidates(r).length" class="text-2xs text-muted-foreground px-1 py-1">{{ t('ui.storage.RaidSection.noSuitableDiskIsFree') }}</p>
                <Item v-for="d in replacementCandidates(r)" :key="d.name" as="button" type="button" size="sm"
                  class="w-full flex-nowrap gap-2 px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                  :disabled="memberBusy !== null" @click="addMember(r, d)">
                  <span class="font-mono text-xs text-foreground">/dev/{{ d.name }}</span>
                  <span class="text-2xs text-muted-foreground">{{ fmtBytes(d.size) }}</span>
                  <span v-if="memberIdentity(d.name)" class="text-2xs text-muted-foreground truncate">{{ memberIdentity(d.name) }}</span>
                </Item>
                <Button variant="ghost" size="xs" type="button" @click="addPicker = null">{{ t('ui.storage.RaidSection.cancel') }}</Button>
              </div>
            </div>
          </div>

          <!-- Usage & mount actions -->
          <template v-if="raidBlockDev(r.name)">
            <div class="border-t border-border px-4 py-3 flex items-center gap-3">
              <div class="flex-1 min-w-0">
                <div v-if="raidBlockDev(r.name)!.mountpoint">
                  <div class="flex justify-between items-baseline mb-1.5">
                    <span class="text-2xs font-mono text-muted-foreground">{{ raidBlockDev(r.name)!.mountpoint }}</span>
                    <span class="text-2xs text-muted-foreground">{{ fmtBytes(raidBlockDev(r.name)!.usageUsed) }} / {{ fmtBytes(raidBlockDev(r.name)!.usageTotal) }}</span>
                  </div>
                  <Progress class="h-1 bg-muted rounded-full" :model-value="usagePct(raidBlockDev(r.name)!)" :indicator-class="['rounded-full', usageBarClass(usagePct(raidBlockDev(r.name)!))]" />
                  <div class="text-2xs text-muted-foreground mt-1">{{ t('uip.storage.RaidSection.free', { p0: fmtBytes(raidBlockDev(r.name)!.usageFree), p1: usagePct(raidBlockDev(r.name)!).toFixed(1) }) }}</div>
                </div>
                <div v-else-if="raidBlockDev(r.name)!.fstype" class="text-2xs text-muted-foreground">
                  {{ t('ui.storage.RaidSection.formatted') }} <span class="font-mono text-foreground/80">{{ raidBlockDev(r.name)!.fstype }}</span>{{ t('ui.storage.RaidSection.notMounted') }}
                </div>
                <div v-else class="text-2xs text-muted-foreground">{{ t('ui.storage.RaidSection.noFilesystemFormatBeforeMounting') }}</div>
              </div>
              <div class="flex gap-1.5 shrink-0">
                <Button variant="outline" size="xs" v-if="!raidBlockDev(r.name)!.mountpoint" @click="openFormat(raidBlockDev(r.name)!)"
                  class="text-foreground/80 hover:border-primary/50 hover:text-primary">
                  {{ t('ui.storage.RaidSection.format') }}
                </Button>
                <Button variant="outline" size="xs" v-if="raidBlockDev(r.name)!.fstype && !raidBlockDev(r.name)!.mountpoint" @click="openMount(raidBlockDev(r.name)!)"
                  class="text-foreground/80 hover:border-success/50 hover:text-success">
                  {{ t('ui.storage.RaidSection.mount') }}
                </Button>
                <Button variant="outline" size="xs" v-if="raidBlockDev(r.name)!.mountpoint" @click="openUmount(raidBlockDev(r.name)!)"
                  class="text-foreground/80 hover:border-warning/50 hover:text-warning">
                  {{ t('ui.storage.RaidSection.unmount') }}
                </Button>
              </div>
            </div>
          </template>
        </div>
      </Card>
    </div>

    <!-- Shared device dialogs (format / mount / unmount) -->
    <DeviceFormatWizard  ref="formatWiz" @done="refresh" @mount="d => mountDlg?.open(d)" />
    <DeviceMountDialog   ref="mountDlg"  @done="refresh" />
    <DeviceUnmountDialog ref="umountDlg" @done="refresh" />

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- CREATE RAID WIZARD                                                   -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Modal v-if="raidWiz" panel-class="w-full max-w-lg" :show-close="false" :prevent-close="!!raidWiz.busy" @close="raidWiz = null">

          <!-- Step indicator -->
          <div class="flex items-center gap-0 border-b border-border">
            <div v-for="(label, i) in ['RAID Level', 'Select Drives', 'Confirm']" :key="i"
              :class="['flex-1 py-2.5 text-center text-2xs font-semibold transition-colors',
                raidWiz.step === i + 1 ? 'text-primary border-b-2 border-primary'
                : raidWiz.step > i + 1  ? 'text-muted-foreground'
                : 'text-muted-foreground/50']"
            >{{ i + 1 }}. {{ label }}</div>
          </div>

          <!-- Step 1: Choose RAID level -->
          <div v-if="raidWiz.step === 1" class="p-5 space-y-3">
            <p class="flex items-center gap-1.5 text-sm text-muted-foreground">
              {{ t('ui.storage.RaidSection.chooseTheRaidConfigurationThat') }}
              <Hint text="Each diagram shows how one chunk of data is placed on the drives. Same letter = identical copy. Different letters = split across drives. P = a parity block, used to rebuild data if a drive fails." />
            </p>

            <!-- Own container: the dialog is teleported out of the Storage panel. -->
            <div class="@container"><div role="radiogroup" :aria-label="t('ui.storage.RaidSection.raidLevel')" class="grid grid-cols-1 @md:grid-cols-2 gap-2">
              <Item
                v-for="lvl in RAID_LEVELS" :key="lvl.level"
                as="button" type="button" variant="outline" role="radio" :aria-checked="raidWiz.level === lvl.level"
                @click="raidWiz.level = lvl.level"
                :class="['block p-3 text-left rounded-xl',
                  raidWiz.level === lvl.level
                    ? 'border-primary bg-primary/5'
                    : 'hover:border-input']"
              >
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-sm font-bold text-foreground">{{ lvl.name }}</span>
                  <span class="text-2xs text-muted-foreground">{{ lvl.sub }}</span>
                </div>
                <div class="text-2xs text-muted-foreground leading-relaxed">{{ lvl.desc }}</div>
                <div class="flex items-center gap-3 mt-2 text-2xs">
                  <span class="text-muted-foreground">{{ t('uip.storage.RaidSection.minDrives', { p0: lvl.minDev }) }}</span>
                  <span :class="lvl.redundancy === 'None' ? 'text-destructive' : 'text-success'">
                    {{ t('uip.storage.RaidSection.redundancy', { p0: lvl.redundancy }) }}
                  </span>
                </div>
                <RaidLevelVisual :level="lvl.level" class="mt-2.5 pt-2.5 border-t border-border" />
              </Item>
            </div></div>

            <!-- Selected level danger notice -->
            <Alert variant="warning" class="flex items-start gap-2 px-3 py-2 text-2xs text-warning" role="note">
              <TriangleAlertIcon class="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{{ selectedRaidLevel.danger }}</span>
            </Alert>

            <div class="flex gap-2 pt-1">
              <Button variant="outline" @click="raidWiz = null" class="flex-1 justify-center">{{ t('ui.storage.RaidSection.cancel') }}</Button>
              <Button @click="raidWiz.step = 2" class="flex-1 justify-center">{{ t('ui.storage.RaidSection.next') }}</Button>
            </div>
          </div>

          <!-- Step 2: Select drives -->
          <div v-else-if="raidWiz.step === 2" class="p-5 space-y-3">
            <p class="text-sm text-foreground/80">
              {{ t('ui.storage.RaidSection.selectDrivesFor') }} <strong>{{ selectedRaidLevel.name }}</strong>.
              <span class="text-muted-foreground">{{ t('uip.storage.RaidSection.minimumRequired', { p0: selectedRaidLevel.minDev }) }}</span>
            </p>

            <!-- Capacity: computed from the selected drives once there are enough -->
            <div class="px-1 space-y-0.5">
              <div v-if="wizardCapacity?.cap.valid" class="text-xs text-foreground">
                {{ t('ui.storage.RaidSection.usable') }} <strong>{{ fmtBytes(wizardCapacity.cap.usable) }}</strong>
                {{ t('uip.storage.RaidSection.ofRaw', { p0: fmtBytes(wizardCapacity.cap.raw), p1: wizardCapacity.cap.efficiency, p2: toleranceText(wizardCapacity.cap.faultTolerance, wizardCapacity.cap.maxFaultTolerance) }) }}
              </div>
              <div v-for="w in wizardCapacity?.cap.valid ? wizardCapacity.waste : []" :key="w.name" class="text-2xs text-warning">
                {{ t('uip.storage.RaidSection.unusedOnDevDrivesAre', { p0: fmtBytes(w.bytes), p1: w.name }) }}
              </div>
              <div class="text-2xs text-muted-foreground">{{ selectedRaidLevel.capacityHint }}</div>
            </div>

            <div v-if="eligibleForRaid.length === 0" class="py-6 text-center text-sm text-muted-foreground">
              {{ t('ui.storage.RaidSection.noEligibleDrivesAvailable') }}<br>
              <span class="text-xs">{{ t('ui.storage.RaidSection.drivesMustBeUnmountedNot') }}</span>
            </div>

            <div v-else class="space-y-1.5 max-h-60 overflow-y-auto pr-1">
              <label
                v-for="dev in eligibleForRaid" :key="dev.name"
                :class="['flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors',
                  raidWiz.devs.includes(dev.name)
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-input']"
                @click="toggleRaidDev(dev.name)"
              >
                <div :class="['w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                  raidWiz.devs.includes(dev.name) ? 'border-primary bg-primary' : 'border-input']">
                  <CheckIcon v-if="raidWiz.devs.includes(dev.name)" class="w-2.5 h-2.5 text-white" aria-hidden="true" />
                </div>
                <div class="flex-1 min-w-0">
                  <span class="text-sm font-mono text-foreground">/dev/{{ dev.name }}</span>
                  <span v-if="dev.model" class="text-xs text-muted-foreground ml-2">{{ dev.model }}</span>
                </div>
                <span class="text-xs text-muted-foreground shrink-0">{{ fmtBytes(dev.size) }}</span>
              </label>
            </div>

            <div v-if="raidWiz.devs.length > 0 && !raidCanAdvance" class="text-2xs text-warning px-1">
              {{ t('uip.storage.RaidSection.requiresAtLeastDrivesSelected', { p0: selectedRaidLevel.name, p1: selectedRaidLevel.minDev, p2: raidWiz.devs.length }) }}
            </div>

            <!-- Array name -->
            <div>
              <label class="block text-xs font-medium text-foreground/80 mb-1.5">{{ t('ui.storage.RaidSection.arrayName') }}</label>
              <Input
                v-model="raidWiz.name"
                type="text"
                laceholder="md0"
                class="w-full px-3 py-2 text-sm font-mono"
              />
              <p class="text-2xs text-muted-foreground mt-1">{{ t('ui.storage.RaidSection.willCreate') }} <span class="font-mono">/dev/{{ raidWiz.name || 'md0' }}</span></p>
            </div>

            <div class="flex gap-2 pt-1">
              <Button variant="outline" @click="raidWiz.step = 1" class="flex-1 justify-center">{{ t('ui.storage.RaidSection.back') }}</Button>
              <Button @click="raidWiz.step = 3" :disabled="!raidCanAdvance || !raidWiz.name"
                class="flex-1 justify-center">
                {{ t('ui.storage.RaidSection.next') }}
              </Button>
            </div>
          </div>

          <!-- Step 3: Confirm -->
          <div v-else-if="raidWiz.step === 3" class="p-5 space-y-4">
            <Alert variant="destructive" class="flex items-start gap-3 p-4 text-foreground" role="note">
              <TriangleAlertIcon class="w-5 h-5 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <div class="font-semibold text-destructive text-sm mb-1">{{ t('ui.storage.RaidSection.allDataOnSelectedDrives') }}</div>
                <div class="text-xs text-destructive/80">
                  {{ t('ui.storage.RaidSection.creatingThisRaidArrayWill') }}
                </div>
              </div>
            </Alert>

            <div class="space-y-1 text-xs text-muted-foreground">
              <div class="flex gap-2"><span class="w-20 text-foreground/80">{{ t('ui.storage.RaidSection.array') }}</span><span class="font-mono">/dev/{{ raidWiz.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-foreground/80">{{ t('ui.storage.RaidSection.level') }}</span><span>{{ selectedRaidLevel.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-foreground/80">{{ t('ui.storage.RaidSection.drives') }}</span><span class="font-mono">{{ raidWiz.devs.join(', ') }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-foreground/80">{{ t('ui.storage.RaidSection.capacity') }}</span>
                <span v-if="wizardCapacity?.cap.valid">{{ t('uip.storage.RaidSection.usableOfRaw', { p0: fmtBytes(wizardCapacity.cap.usable), p1: fmtBytes(wizardCapacity.cap.raw), p2: wizardCapacity.cap.efficiency }) }}</span>
                <span v-else>{{ selectedRaidLevel.capacityHint }}</span>
              </div>
              <div v-if="wizardCapacity?.cap.valid" class="flex gap-2"><span class="w-20 text-foreground/80">{{ t('ui.storage.RaidSection.redundancy') }}</span><span>{{ toleranceText(wizardCapacity.cap.faultTolerance, wizardCapacity.cap.maxFaultTolerance) }}</span></div>
            </div>

            <div>
              <label class="block text-xs text-foreground/80 mb-1.5">
                {{ t('ui.storage.RaidSection.type') }} <span class="font-mono font-bold text-foreground">{{ t('ui.storage.RaidSection.createRaid2') }}</span> {{ t('ui.storage.RaidSection.toConfirm') }}
              </label>
              <Input
                v-model="raidWiz.confirm"
                type="text"
                :placeholder="t('ui.storage.RaidSection.createRaid2')"
                class="w-full px-3 py-2 text-sm font-mono placeholder-muted-foreground"
              />
            </div>

            <p v-if="raidWiz.err" role="alert" class="px-1 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ raidWiz.err }}</p>

            <div class="flex gap-2">
              <Button variant="outline" @click="raidWiz.step = 2" :disabled="raidWiz.busy" class="flex-1 justify-center">{{ t('ui.storage.RaidSection.back') }}</Button>
              <Button variant="destructive"
                @click="doCreateRaid"
                :disabled="raidWiz.confirm !== 'CREATE RAID' || raidWiz.busy"
                class="flex-1 justify-center"
              >
                <span v-if="raidWiz.busy">{{ t('ui.storage.RaidSection.creating') }}</span>
                <span v-else>{{ t('ui.storage.RaidSection.createRaid3') }}</span>
              </Button>
            </div>
          </div>

    </Modal>

    <!-- Destroy RAID array -->
    <ConfirmDestroyDialog
      v-if="destroyDlg"
      :title="t('ui.storage.RaidSection.destroyRaidArray')"
      subtitle="This will stop the array and erase RAID metadata from all member drives."
      :confirm-word="destroyDlg.raid.name"
      action-label="Destroy array"
      busy-label="Destroying…"
      :busy="destroyDlg.busy"
      :error="destroyDlg.err"
      @confirm="doDestroyRaid"
      @close="destroyDlg = null"
    >
      <template #warning>{{ t('ui.storage.RaidSection.allDataOn') }} <span class="font-mono font-bold">/dev/{{ destroyDlg.raid.name }}</span> {{ t('ui.storage.RaidSection.willBePermanentlyLostMake') }}</template>
      <template #details>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">{{ t('ui.storage.RaidSection.array') }}</span><span class="font-mono">/dev/{{ destroyDlg.raid.name }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">{{ t('ui.storage.RaidSection.level') }}</span><span>{{ raidLevelLabel(destroyDlg.raid.level) }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">{{ t('ui.storage.RaidSection.members') }}</span><span class="font-mono">{{ destroyDlg.raid.devices.join(', ') }}</span></div>
      </template>
    </ConfirmDestroyDialog>

  </div>
</template>
