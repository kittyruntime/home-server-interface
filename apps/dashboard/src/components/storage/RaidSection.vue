<script setup lang="ts">
import { ref, computed } from 'vue'
import { trpc } from '../../lib/trpc'
import {
  useStorageData, fmtBytes, usagePct, usageBarClass,
  raidLevelLabel, raidDescription, isRaidHealthy,
  type BlockDev, type RaidArray,
} from '../../composables/useStorageData'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import DeviceFormatWizard from './dialogs/DeviceFormatWizard.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'
import Modal from '../ui/Modal.vue'

const emit = defineEmits<{ navigate: [section: 'disks' | 'lvm'] }>()

const { loading, error, devices, raids, lvmPVs, refresh } = useStorageData()

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

// lsblk reports RAID devices as type "raid0", "raid1", "raid5", "raid10" — not "md".
// A device or any of its descendants is "committed to RAID" if its name is a known
// RAID member or array name. We check recursively so parent disks of RAID-member
// partitions are also excluded.
function makeRaidChecker(inRaid: Set<string>, mdNames: Set<string>) {
  function committedToRaid(dev: BlockDev): boolean {
    if (inRaid.has(dev.name) || mdNames.has(dev.name)) return true
    return (dev.children ?? []).some(committedToRaid)
  }
  return committedToRaid
}

// Eligible for RAID creation: free disks/partitions with no RAID commitment anywhere in their subtree
const eligibleForRaid = computed<BlockDev[]>(() => {
  const inRaid  = new Set(raids.value.flatMap(r => r.devices))
  const mdNames = new Set(raids.value.map(r => r.name))
  const pvDevs  = new Set(lvmPVs.value.map(p => p.name.replace('/dev/', '')))
  const committed = makeRaidChecker(inRaid, mdNames)
  const out: BlockDev[] = []
  function collect(dev: BlockDev) {
    if (committed(dev)) return  // skip device AND its subtree
    if (!dev.isSystem && !dev.mountpoint && !pvDevs.has(dev.name) &&
        dev.type !== 'rom' && dev.type !== 'loop' && dev.type !== 'lvm') {
      out.push(dev)
    }
    dev.children?.forEach(collect)
  }
  devices.value.forEach(collect)
  return out
})

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
    await refresh()
  } catch (e: any) {
    d.err = e?.message ?? 'Failed to destroy RAID'
  } finally {
    if (destroyDlg.value) d.busy = false
  }
}

const openMenu = ref<string | null>(null)
</script>

<template>
  <div>
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">RAID</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Manage software RAID arrays (mdadm).</p>
      </div>
      <div class="flex items-center gap-2">
        <button @click="openRaidWizard" class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
          Create RAID
        </button>
        <button @click="refresh" :disabled="loading" title="Refresh" class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>
      </div>
    </div>

    <div v-if="loading && !raids.length" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6"><LoadingSpinner /> Loading…</div>
    <div v-else-if="error" class="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{{ error }}</div>

    <div v-if="openMenu" class="fixed inset-0 z-20" @click="openMenu = null"/>

    <!-- RAID arrays list -->
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <span v-if="raids.length" class="text-[10px] px-1.5 py-0.5 rounded-sm bg-[var(--c-surface-deep)] text-[var(--c-text-3)] tabular-nums">{{ raids.length }} array{{ raids.length !== 1 ? 's' : '' }}</span>
      </div>
    </div>

    <div v-if="raids.length === 0 && !loading" class="rounded-xl border border-dashed border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-6 text-center text-sm text-[var(--c-text-3)]">
      No RAID arrays configured. Create one to combine multiple drives for redundancy or performance.
    </div>

    <div v-else class="space-y-3">
      <div v-for="r in raids" :key="r.name"
        class="rounded-xl border bg-[var(--c-surface)] overflow-hidden flex"
        :class="isRaidHealthy(r) ? 'border-[var(--c-border)]' : 'border-danger/20'">
        <!-- Left accent stripe -->
        <div class="w-0.5 shrink-0" :class="isRaidHealthy(r) ? 'bg-[var(--c-accent)]/50' : 'bg-danger'"/>
        <div class="flex-1 min-w-0">
          <!-- Header -->
          <div class="flex items-center gap-3 px-4 pt-3.5 pb-2">
            <span class="text-[11px] font-bold px-2 py-0.5 rounded-sm tracking-wide shrink-0"
              :class="isRaidHealthy(r) ? 'bg-[var(--c-accent)]/10 text-[var(--c-accent)]' : 'bg-danger/10 text-danger'">
              {{ raidLevelLabel(r.level) }}
            </span>
            <span class="font-mono text-sm text-[var(--c-text-1)]">/dev/{{ r.name }}</span>
            <div class="ml-auto flex items-center gap-3 shrink-0">
              <span class="text-[11px] text-[var(--c-text-3)]">{{ r.active }}/{{ r.total }} drives</span>
              <span class="inline-flex items-center gap-1.5 text-[11px] font-medium" :class="isRaidHealthy(r) ? 'text-success' : 'text-danger'">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="isRaidHealthy(r) ? 'bg-success' : 'bg-danger animate-pulse'"/>
                {{ isRaidHealthy(r) ? 'Healthy' : r.state }}
              </span>
              <!-- Cross-nav: RAID used as LVM PV -->
              <button v-if="raidPvVg(r.name)" @click="emit('navigate', 'lvm')"
                class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors">
                LVM {{ raidPvVg(r.name) }} →
              </button>
              <!-- ⋯ menu -->
              <div class="relative z-30">
                <button @click.stop="openMenu = openMenu === r.name ? null : r.name"
                  :class="['w-7 h-7 flex items-center justify-center rounded-lg transition-colors', openMenu === r.name ? 'bg-[var(--c-hover)] text-[var(--c-text-1)]' : 'text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)]']">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
                  </svg>
                </button>
                <div v-if="openMenu === r.name"
                  class="absolute right-0 top-full mt-1.5 bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl shadow-[var(--shadow-md)] overflow-hidden min-w-[176px]">
                  <div class="px-3 pt-2.5 pb-1.5 border-b border-[var(--c-border)]">
                    <p class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Danger zone</p>
                  </div>
                  <button @click="openDestroy(r); openMenu = null"
                    class="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-danger hover:bg-danger/10 transition-colors text-left">
                    <svg class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                      <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/>
                    </svg>
                    Destroy array…
                  </button>
                </div>
              </div>
            </div>
          </div>
          <p v-if="raidDescription(r.level)" class="text-[11px] text-[var(--c-text-3)] px-4 pb-3">{{ raidDescription(r.level) }}</p>

          <!-- Drive bay -->
          <div class="px-4 pb-4">
            <div class="flex items-center gap-1.5 flex-wrap">
              <template v-for="(dev, idx) in r.devices" :key="dev">
                <div class="flex flex-col items-center gap-1.5">
                  <div class="relative rounded-lg border transition-colors"
                    :class="idx < r.active ? 'border-[var(--c-border-strong)] bg-[var(--c-surface-deep)]' : 'border-danger/40 bg-danger/5'">
                    <svg viewBox="0 0 52 68" class="w-12 h-16">
                      <rect x="3" y="3" width="46" height="62" rx="5"
                        :fill="idx < r.active ? 'var(--c-surface-deep)' : 'color-mix(in srgb, var(--c-danger) 6%, transparent)'"
                        :stroke="idx < r.active ? 'var(--c-border-strong)' : 'color-mix(in srgb, var(--c-danger) 50%, transparent)'" stroke-width="1.5"/>
                      <circle cx="9" cy="10" r="2" fill="var(--c-surface)" opacity="0.8"/>
                      <circle cx="43" cy="10" r="2" fill="var(--c-surface)" opacity="0.8"/>
                      <circle cx="9" cy="58" r="2" fill="var(--c-surface)" opacity="0.8"/>
                      <circle cx="43" cy="58" r="2" fill="var(--c-surface)" opacity="0.8"/>
                      <circle cx="26" cy="32" r="12" fill="none" :stroke="idx < r.active ? 'var(--c-accent)' : 'color-mix(in srgb, var(--c-danger) 50%, transparent)'" stroke-width="1" opacity="0.35"/>
                      <circle cx="26" cy="32" r="6" fill="none" :stroke="idx < r.active ? 'var(--c-accent)' : 'color-mix(in srgb, var(--c-danger) 50%, transparent)'" stroke-width="1" opacity="0.35"/>
                      <line x1="26" y1="32" x2="35" y2="21" :stroke="idx < r.active ? 'var(--c-accent)' : 'color-mix(in srgb, var(--c-danger) 60%, transparent)'" stroke-width="1.5" opacity="0.5" stroke-linecap="round"/>
                      <circle cx="26" cy="32" r="2.5" :fill="idx < r.active ? 'var(--c-accent)' : 'color-mix(in srgb, var(--c-danger) 70%, transparent)'" opacity="0.8"/>
                      <circle cx="40" cy="50" r="2" :fill="idx < r.active ? 'var(--c-success)' : 'var(--c-danger)'" opacity="0.9"/>
                      <rect x="15" y="60" width="22" height="2.5" rx="1" fill="var(--c-text-3)" opacity="0.25"/>
                    </svg>
                  </div>
                  <button @click="emit('navigate', 'disks')"
                    class="text-[10px] font-mono hover:underline transition-colors"
                    :class="idx < r.active ? 'text-[var(--c-text-3)] hover:text-[var(--c-text-1)]' : 'text-danger'">
                    /dev/{{ dev }}
                  </button>
                </div>
                <svg v-if="idx < r.devices.length - 1" class="w-3.5 h-3.5 text-[var(--c-text-3)] self-center mb-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                </svg>
              </template>
              <div class="flex items-center self-center mb-5 gap-2 ml-1">
                <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                </svg>
                <div>
                  <div class="text-[11px] font-semibold text-[var(--c-text-2)]">{{ raidLevelLabel(r.level) }}</div>
                  <div class="text-[10px] text-[var(--c-text-3)] font-mono">{{ raidBlockDev(r.name)?.mountpoint || 'not mounted' }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Usage & mount actions -->
          <template v-if="raidBlockDev(r.name)">
            <div class="border-t border-[var(--c-border)] px-4 py-3 flex items-center gap-3">
              <div class="flex-1 min-w-0">
                <div v-if="raidBlockDev(r.name)!.mountpoint">
                  <div class="flex justify-between items-baseline mb-1.5">
                    <span class="text-[11px] font-mono text-[var(--c-text-3)]">{{ raidBlockDev(r.name)!.mountpoint }}</span>
                    <span class="text-[11px] text-[var(--c-text-3)]">{{ fmtBytes(raidBlockDev(r.name)!.usageUsed) }} / {{ fmtBytes(raidBlockDev(r.name)!.usageTotal) }}</span>
                  </div>
                  <div class="h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                    <div class="h-full rounded-full" :class="usageBarClass(usagePct(raidBlockDev(r.name)!))" :style="{ width: usagePct(raidBlockDev(r.name)!) + '%' }"/>
                  </div>
                  <div class="text-[10px] text-[var(--c-text-3)] mt-1">{{ fmtBytes(raidBlockDev(r.name)!.usageFree) }} free · {{ usagePct(raidBlockDev(r.name)!).toFixed(1) }}%</div>
                </div>
                <div v-else-if="raidBlockDev(r.name)!.fstype" class="text-[11px] text-[var(--c-text-3)]">
                  Formatted <span class="font-mono text-[var(--c-text-2)]">{{ raidBlockDev(r.name)!.fstype }}</span> — not mounted
                </div>
                <div v-else class="text-[11px] text-[var(--c-text-3)] italic">No filesystem — format before mounting</div>
              </div>
              <div class="flex gap-1.5 shrink-0">
                <button v-if="!raidBlockDev(r.name)!.mountpoint" @click="openFormat(raidBlockDev(r.name)!)"
                  class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                  Format
                </button>
                <button v-if="raidBlockDev(r.name)!.fstype && !raidBlockDev(r.name)!.mountpoint" @click="openMount(raidBlockDev(r.name)!)"
                  class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-success/50 hover:text-success transition-colors">
                  Mount
                </button>
                <button v-if="raidBlockDev(r.name)!.mountpoint" @click="openUmount(raidBlockDev(r.name)!)"
                  class="text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-warning/50 hover:text-warning transition-colors">
                  Unmount
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Shared device dialogs (format / mount / unmount) -->
    <DeviceFormatWizard  ref="formatWiz" @done="refresh" />
    <DeviceMountDialog   ref="mountDlg"  @done="refresh" />
    <DeviceUnmountDialog ref="umountDlg" @done="refresh" />

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- CREATE RAID WIZARD                                                   -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Modal v-if="raidWiz" panel-class="w-full max-w-lg" :show-close="false" :prevent-close="!!raidWiz.busy" @close="raidWiz = null">

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
                  <span :class="lvl.redundancy === 'None' ? 'text-danger' : 'text-success'">
                    Redundancy: {{ lvl.redundancy }}
                  </span>
                </div>
              </button>
            </div>

            <!-- Selected level danger notice -->
            <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/5 border border-warning/20 text-[11px] text-warning">
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
              <span class="text-xs">Drives must be unmounted, not already in a RAID or LVM, and not a system disk.</span>
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

            <div v-if="raidWiz.devs.length > 0 && !raidCanAdvance" class="text-[11px] text-warning px-1">
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
            <div class="flex items-start gap-3 p-4 rounded-xl bg-danger/10 border border-danger/30">
              <svg class="w-5 h-5 text-danger mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
              <div>
                <div class="font-semibold text-danger text-sm mb-1">All data on selected drives will be erased</div>
                <div class="text-xs text-danger/80">
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
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-danger transition-colors"
              />
            </div>

            <div v-if="raidWiz.err" class="text-xs text-danger px-1">{{ raidWiz.err }}</div>

            <div class="flex gap-2">
              <button @click="raidWiz.step = 2" :disabled="raidWiz.busy" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors disabled:opacity-50">← Back</button>
              <button
                @click="doCreateRaid"
                :disabled="raidWiz.confirm !== 'CREATE RAID' || raidWiz.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/85 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
              >
                <span v-if="raidWiz.busy">Creating…</span>
                <span v-else>Create RAID</span>
              </button>
            </div>
          </div>

    </Modal>

    <!-- ════════════════════════════════════════════════════════════════════ -->
    <!-- DESTROY RAID DIALOG                                                  -->
    <!-- ════════════════════════════════════════════════════════════════════ -->
    <Modal v-if="destroyDlg" panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!destroyDlg.busy" @close="destroyDlg = null">
          <div class="px-5 py-4 border-b border-[var(--c-border)] bg-danger/5">
            <h3 class="font-semibold text-danger">Destroy RAID array</h3>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">This will stop the array and erase RAID metadata from all member drives.</p>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-start gap-2 p-3 rounded-lg bg-danger/10 border border-danger/20 text-xs text-danger">
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
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-danger transition-colors"
              />
            </div>

            <div v-if="destroyDlg.err" class="text-xs text-danger">{{ destroyDlg.err }}</div>

            <div class="flex gap-2">
              <button @click="destroyDlg = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
              <button
                @click="doDestroyRaid"
                :disabled="destroyDlg.confirm !== destroyDlg.raid.name || destroyDlg.busy"
                class="flex-1 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/85 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
              >
                <span v-if="destroyDlg.busy">Destroying…</span>
                <span v-else>Destroy array</span>
              </button>
            </div>
          </div>
    </Modal>

  </div>
</template>
