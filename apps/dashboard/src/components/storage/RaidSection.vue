<script setup lang="ts">
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

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
    if (e?.message !== '') toast.error(e?.message ?? `Could not ${op} /dev/${device}`)
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
  if (n === 0) return 'no drive failure tolerated'
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
      { title: `Create RAID ${w.level} /dev/${w.name}`, actionLabel: `Create /dev/${w.name}` })
    raidWiz.value = null
    await refresh()
  } catch (e: any) {
    w.err = e?.message ?? 'RAID creation failed'
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
      { title: `Delete RAID /dev/${d.raid.name}`, actionLabel: `Delete /dev/${d.raid.name}` })
    // The array is gone; anything left behind (a signature that could not be
    // wiped, a config file that could not be updated) is reported, not fatal.
    for (const w of res.warnings ?? []) toast.error(w)
    destroyDlg.value = null
    await refresh()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to destroy RAID'
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
        <h2 class="text-lg font-semibold text-foreground">Arrays</h2>
        <p class="text-sm text-muted-foreground mt-0.5">Manage software RAID arrays (mdadm).</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="openRaidWizard()" :disabled="isMissing('mdadm')"
          :title="isMissing('mdadm') ? 'mdadm is not installed: sudo apt install mdadm' : undefined">
          <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
          Create RAID…
        </Button>
        <Button variant="ghost" size="icon-sm" @click="refresh" :disabled="loading" title="Refresh" class="text-muted-foreground hover:text-foreground">
          <LoadingSpinner v-if="loading" class="text-base" />
          <RefreshCwIcon v-else class="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>
    </div>

    <ImportFound v-if="!only" kind="raid" @imported="refresh" />

    <LoadingState v-if="loading && !raids.length" variant="block" />
    <div v-else-if="error" role="alert" class="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{{ error }}</div>

    <!-- RAID arrays list -->
    <div v-if="!only" class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <span v-if="raids.length" class="text-2xs px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground tabular-nums">{{ raids.length }} array{{ raids.length !== 1 ? 's' : '' }}</span>
      </div>
    </div>

    <div v-if="!only && raids.length === 0 && !loading" class="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
      No RAID arrays configured. Create one to combine multiple drives for redundancy or performance.
    </div>

    <div v-else class="space-y-3">
      <div v-for="r in shown" :key="r.name"
        class="rounded-xl border bg-card overflow-hidden flex"
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
                LVM {{ raidPvVg(r.name) }} →
              </Button>
              <!-- ⋯ menu -->
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="Array actions">
                    <EllipsisVerticalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="min-w-[176px]">
                  <DropdownMenuLabel class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Danger zone</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" @select="openDestroy(r)">
                    <Trash2Icon />
                    Destroy array…
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
                <span v-if="r.syncAction === 'recovery'" class="text-muted-foreground">redundancy returns when it finishes</span>
              </div>
              <div class="h-1.5 rounded-full bg-muted overflow-hidden">
                <div class="h-full bg-primary transition-all" :style="{ width: r.resyncPercent + '%' }"/>
              </div>
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
                  :disabled="memberBusy !== null" @click="failMember(r, m)">Mark as failed</Button>
                <Button variant="outline" size="xs" v-else-if="m.role === 'faulty' || m.role === 'spare'" type="button" class="shrink-0"
                  :disabled="memberBusy !== null" @click="removeMember(r, m)">
                  {{ memberBusy === `${r.name}:${m.name}` ? 'Removing…' : 'Remove' }}
                </Button>
              </div>
              <div v-if="emptySlots(r) > 0" class="px-3 py-2 text-2xs text-destructive">
                {{ emptySlots(r) }} empty slot{{ emptySlots(r) > 1 ? 's' : '' }}: add a replacement disk to restore redundancy.
              </div>
            </div>

            <div class="mt-2">
              <Button variant="ghost" size="xs" v-if="addPicker !== r.name" type="button" :disabled="memberBusy !== null"
                @click="addPicker = r.name">+ Add a disk</Button>
              <div v-else class="rounded-lg border border-border p-2 space-y-1">
                <p class="text-2xs text-muted-foreground px-1">Free disks at least as large as the smallest member:</p>
                <p v-if="!replacementCandidates(r).length" class="text-2xs text-muted-foreground px-1 py-1">No suitable disk is free.</p>
                <button v-for="d in replacementCandidates(r)" :key="d.name" type="button"
                  class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-accent"
                  :disabled="memberBusy !== null" @click="addMember(r, d)">
                  <span class="font-mono text-xs text-foreground">/dev/{{ d.name }}</span>
                  <span class="text-2xs text-muted-foreground">{{ fmtBytes(d.size) }}</span>
                  <span v-if="memberIdentity(d.name)" class="text-2xs text-muted-foreground truncate">{{ memberIdentity(d.name) }}</span>
                </button>
                <Button variant="ghost" size="xs" type="button" @click="addPicker = null">Cancel</Button>
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
                  <div class="h-1 bg-muted rounded-full overflow-hidden">
                    <div class="h-full rounded-full" :class="usageBarClass(usagePct(raidBlockDev(r.name)!))" :style="{ width: usagePct(raidBlockDev(r.name)!) + '%' }"/>
                  </div>
                  <div class="text-2xs text-muted-foreground mt-1">{{ fmtBytes(raidBlockDev(r.name)!.usageFree) }} free · {{ usagePct(raidBlockDev(r.name)!).toFixed(1) }}%</div>
                </div>
                <div v-else-if="raidBlockDev(r.name)!.fstype" class="text-2xs text-muted-foreground">
                  Formatted <span class="font-mono text-foreground/80">{{ raidBlockDev(r.name)!.fstype }}</span>, not mounted
                </div>
                <div v-else class="text-2xs text-muted-foreground">No filesystem: format before mounting</div>
              </div>
              <div class="flex gap-1.5 shrink-0">
                <Button variant="outline" size="xs" v-if="!raidBlockDev(r.name)!.mountpoint" @click="openFormat(raidBlockDev(r.name)!)"
                  class="text-foreground/80 hover:border-primary/50 hover:text-primary">
                  Format
                </Button>
                <Button variant="outline" size="xs" v-if="raidBlockDev(r.name)!.fstype && !raidBlockDev(r.name)!.mountpoint" @click="openMount(raidBlockDev(r.name)!)"
                  class="text-foreground/80 hover:border-success/50 hover:text-success">
                  Mount
                </Button>
                <Button variant="outline" size="xs" v-if="raidBlockDev(r.name)!.mountpoint" @click="openUmount(raidBlockDev(r.name)!)"
                  class="text-foreground/80 hover:border-warning/50 hover:text-warning">
                  Unmount
                </Button>
              </div>
            </div>
          </template>
        </div>
      </div>
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
              Choose the RAID configuration that matches your needs.
              <Hint text="Each diagram shows how one chunk of data is placed on the drives. Same letter = identical copy. Different letters = split across drives. P = a parity block, used to rebuild data if a drive fails." />
            </p>

            <!-- Own container: the dialog is teleported out of the Storage panel. -->
            <div class="@container"><div class="grid grid-cols-1 @md:grid-cols-2 gap-2">
              <button
                v-for="lvl in RAID_LEVELS" :key="lvl.level"
                @click="raidWiz.level = lvl.level"
                :class="['text-left p-3 rounded-xl border transition-colors',
                  raidWiz.level === lvl.level
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-input']"
              >
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-sm font-bold text-foreground">{{ lvl.name }}</span>
                  <span class="text-2xs text-muted-foreground">{{ lvl.sub }}</span>
                </div>
                <div class="text-2xs text-muted-foreground leading-relaxed">{{ lvl.desc }}</div>
                <div class="flex items-center gap-3 mt-2 text-2xs">
                  <span class="text-muted-foreground">Min: {{ lvl.minDev }} drives</span>
                  <span :class="lvl.redundancy === 'None' ? 'text-destructive' : 'text-success'">
                    Redundancy: {{ lvl.redundancy }}
                  </span>
                </div>
                <RaidLevelVisual :level="lvl.level" class="mt-2.5 pt-2.5 border-t border-border" />
              </button>
            </div></div>

            <!-- Selected level danger notice -->
            <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/5 border border-warning/20 text-2xs text-warning">
              <TriangleAlertIcon class="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{{ selectedRaidLevel.danger }}</span>
            </div>

            <div class="flex gap-2 pt-1">
              <Button variant="outline" @click="raidWiz = null" class="flex-1 justify-center">Cancel</Button>
              <Button @click="raidWiz.step = 2" class="flex-1 justify-center">Next →</Button>
            </div>
          </div>

          <!-- Step 2: Select drives -->
          <div v-else-if="raidWiz.step === 2" class="p-5 space-y-3">
            <p class="text-sm text-foreground/80">
              Select drives for <strong>{{ selectedRaidLevel.name }}</strong>.
              <span class="text-muted-foreground">Minimum {{ selectedRaidLevel.minDev }} required.</span>
            </p>

            <!-- Capacity: computed from the selected drives once there are enough -->
            <div class="px-1 space-y-0.5">
              <div v-if="wizardCapacity?.cap.valid" class="text-xs text-foreground">
                Usable: <strong>{{ fmtBytes(wizardCapacity.cap.usable) }}</strong>
                of {{ fmtBytes(wizardCapacity.cap.raw) }} raw ({{ wizardCapacity.cap.efficiency }}%)
                · {{ toleranceText(wizardCapacity.cap.faultTolerance, wizardCapacity.cap.maxFaultTolerance) }}
              </div>
              <div v-for="w in wizardCapacity?.cap.valid ? wizardCapacity.waste : []" :key="w.name" class="text-2xs text-warning">
                {{ fmtBytes(w.bytes) }} unused on /dev/{{ w.name }} (drives are used at the size of the smallest one)
              </div>
              <div class="text-2xs text-muted-foreground">{{ selectedRaidLevel.capacityHint }}</div>
            </div>

            <div v-if="eligibleForRaid.length === 0" class="py-6 text-center text-sm text-muted-foreground">
              No eligible drives available.<br>
              <span class="text-xs">Drives must be unmounted, not already in a RAID or LVM, and not a system disk.</span>
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
              {{ selectedRaidLevel.name }} requires at least {{ selectedRaidLevel.minDev }} drives ({{ raidWiz.devs.length }} selected).
            </div>

            <!-- Array name -->
            <div>
              <label class="block text-xs font-medium text-foreground/80 mb-1.5">Array name</label>
              <Input
                v-model="raidWiz.name"
                type="text"
                placeholder="md0"
                class="w-full px-3 py-2 text-sm font-mono"
              />
              <p class="text-2xs text-muted-foreground mt-1">Will create <span class="font-mono">/dev/{{ raidWiz.name || 'md0' }}</span></p>
            </div>

            <div class="flex gap-2 pt-1">
              <Button variant="outline" @click="raidWiz.step = 1" class="flex-1 justify-center">← Back</Button>
              <Button @click="raidWiz.step = 3" :disabled="!raidCanAdvance || !raidWiz.name"
                class="flex-1 justify-center">
                Next →
              </Button>
            </div>
          </div>

          <!-- Step 3: Confirm -->
          <div v-else-if="raidWiz.step === 3" class="p-5 space-y-4">
            <div class="flex items-start gap-3 p-4 rounded-xl bg-destructive/10 border border-destructive/30">
              <TriangleAlertIcon class="w-5 h-5 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <div class="font-semibold text-destructive text-sm mb-1">All data on selected drives will be erased</div>
                <div class="text-xs text-destructive/80">
                  Creating this RAID array will permanently destroy all existing data on the selected drives. This cannot be undone.
                </div>
              </div>
            </div>

            <div class="space-y-1 text-xs text-muted-foreground">
              <div class="flex gap-2"><span class="w-20 text-foreground/80">Array</span><span class="font-mono">/dev/{{ raidWiz.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-foreground/80">Level</span><span>{{ selectedRaidLevel.name }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-foreground/80">Drives</span><span class="font-mono">{{ raidWiz.devs.join(', ') }}</span></div>
              <div class="flex gap-2"><span class="w-20 text-foreground/80">Capacity</span>
                <span v-if="wizardCapacity?.cap.valid">{{ fmtBytes(wizardCapacity.cap.usable) }} usable of {{ fmtBytes(wizardCapacity.cap.raw) }} raw ({{ wizardCapacity.cap.efficiency }}%)</span>
                <span v-else>{{ selectedRaidLevel.capacityHint }}</span>
              </div>
              <div v-if="wizardCapacity?.cap.valid" class="flex gap-2"><span class="w-20 text-foreground/80">Redundancy</span><span>{{ toleranceText(wizardCapacity.cap.faultTolerance, wizardCapacity.cap.maxFaultTolerance) }}</span></div>
            </div>

            <div>
              <label class="block text-xs text-foreground/80 mb-1.5">
                Type <span class="font-mono font-bold text-foreground">CREATE RAID</span> to confirm
              </label>
              <Input
                v-model="raidWiz.confirm"
                type="text"
                placeholder="CREATE RAID"
                class="w-full px-3 py-2 text-sm font-mono placeholder-muted-foreground"
              />
            </div>

            <p v-if="raidWiz.err" role="alert" class="px-1 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ raidWiz.err }}</p>

            <div class="flex gap-2">
              <Button variant="outline" @click="raidWiz.step = 2" :disabled="raidWiz.busy" class="flex-1 justify-center">← Back</Button>
              <Button variant="destructive"
                @click="doCreateRaid"
                :disabled="raidWiz.confirm !== 'CREATE RAID' || raidWiz.busy"
                class="flex-1 justify-center"
              >
                <span v-if="raidWiz.busy">Creating…</span>
                <span v-else>Create RAID</span>
              </Button>
            </div>
          </div>

    </Modal>

    <!-- Destroy RAID array -->
    <ConfirmDestroyDialog
      v-if="destroyDlg"
      title="Destroy RAID array"
      subtitle="This will stop the array and erase RAID metadata from all member drives."
      :confirm-word="destroyDlg.raid.name"
      action-label="Destroy array"
      busy-label="Destroying…"
      :busy="destroyDlg.busy"
      :error="destroyDlg.err"
      @confirm="doDestroyRaid"
      @close="destroyDlg = null"
    >
      <template #warning>All data on <span class="font-mono font-bold">/dev/{{ destroyDlg.raid.name }}</span> will be permanently lost. Make sure you have a backup.</template>
      <template #details>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">Array</span><span class="font-mono">/dev/{{ destroyDlg.raid.name }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">Level</span><span>{{ raidLevelLabel(destroyDlg.raid.level) }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">Members</span><span class="font-mono">{{ destroyDlg.raid.devices.join(', ') }}</span></div>
      </template>
    </ConfirmDestroyDialog>

  </div>
</template>
