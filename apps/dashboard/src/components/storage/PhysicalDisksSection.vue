<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { useStorageData, fmtBytes, type BlockDev } from './store'
import { type SmartResult, smartStatus, fetchSmartInto } from './smart'
import {
  diskRow, summarize, filterRows, sortRows, groupRows, isSelectable, ROLE_LABELS,
  type DiskRow, type DiskRole, type DiskHealth, type SortKey, type SortDir,
} from './disk-list'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import DiskCard from './DiskCard.vue'
import DeviceFormatWizard from './dialogs/DeviceFormatWizard.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'
import ConfirmDestroyDialog from './dialogs/ConfirmDestroyDialog.vue'
import Modal from '../ui/Modal.vue'

const emit = defineEmits<{
  navigate: [section: 'raid' | 'lvm']
  // Start creating an array or a volume group with these whole disks.
  create:   [kind: 'raid' | 'lvm', devices: string[]]
}>()

const { loading, error, devices, lvmLVs, refresh } = useStorageData()
const { currentUsername } = useAuth()

// ── SMART ─────────────────────────────────────────────────────────────────────
// Every disk's health is read when the list loads, without waking disks in
// standby (they show as unknown until their SMART panel is opened).

const smartCache = ref<Record<string, SmartResult>>({})
const smartOpen  = ref<Set<string>>(new Set())

function toggleSmart(diskName: string) {
  const s = new Set(smartOpen.value)
  if (s.has(diskName)) { s.delete(diskName) } else {
    s.add(diskName)
    const c = smartCache.value[diskName]
    // Opening the panel is explicit: read a disk that was skipped in standby.
    if (!c || c._error || (!c.available && !c.unsupported && !c._loading)) fetchSmartInto(smartCache, diskName)
  }
  smartOpen.value = s
}

const physicalDisks = computed(() => devices.value.filter(d => d.type === 'disk'))

async function loadHealth(names: string[]) {
  const queue = names.filter(n => !smartCache.value[n])
  // A few at a time: smartctl on a dozen disks at once is slow and noisy.
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (let n = queue.shift(); n; n = queue.shift()) await fetchSmartInto(smartCache, n, { noWake: true })
  })
  await Promise.all(workers)
}
watch(physicalDisks, disks => { void loadHealth(disks.map(d => d.name)) }, { immediate: true })

function healthOf(s: SmartResult | undefined): DiskHealth {
  const st = smartStatus(s)
  return st === 'loading' ? 'unknown' : st
}

const rows = computed<DiskRow<BlockDev>[]>(() => physicalDisks.value.map(d => {
  const s = smartCache.value[d.name]
  return diskRow(d, s && { health: healthOf(s), temperature: s.temperature, rotationRate: s.rotationRate, available: s.available })
}))
const summary = computed(() => summarize(rows.value))

// ── View, filters and sort (remembered per user in this browser) ─────────────

type View = 'table' | 'cards'
type Prefs = {
  view?: View; sortKey: SortKey; sortDir: SortDir; grouped: boolean
  role: DiskRole | 'all'; health: DiskHealth | 'all'; expanded: string[]
}
const PREFS_KEY = computed(() => `hsi.storage.devices.${currentUsername.value ?? ''}`)

function loadPrefs(): Prefs {
  const defaults: Prefs = { sortKey: 'name', sortDir: 'asc', grouped: false, role: 'all', health: 'all', expanded: [] }
  try {
    const raw = localStorage.getItem(PREFS_KEY.value)
    return raw ? { ...defaults, ...JSON.parse(raw) as Partial<Prefs> } : defaults
  } catch {
    return defaults
  }
}

const prefs = ref<Prefs>(loadPrefs())
watch(prefs, p => {
  try { localStorage.setItem(PREFS_KEY.value, JSON.stringify(p)) } catch { /* private mode: not remembered */ }
}, { deep: true })

// The table is the default once there are many disks; a choice sticks.
const view = computed<View>(() => prefs.value.view ?? (physicalDisks.value.length >= 5 ? 'table' : 'cards'))
const search = ref('')

const visibleRows = computed(() => sortRows(
  filterRows(rows.value, { search: search.value, role: prefs.value.role, health: prefs.value.health }),
  prefs.value.sortKey, prefs.value.sortDir))
const groups = computed(() => prefs.value.grouped
  ? groupRows(visibleRows.value)
  : [{ key: 'all', label: '', rows: visibleRows.value }])
const filtered = computed(() => !!search.value || prefs.value.role !== 'all' || prefs.value.health !== 'all')

function setSort(key: SortKey) {
  const p = prefs.value
  if (p.sortKey === key) p.sortDir = p.sortDir === 'asc' ? 'desc' : 'asc'
  else { p.sortKey = key; p.sortDir = 'asc' }
}

// Summary chips toggle the matching filter.
function toggleRole(role: DiskRole) {
  prefs.value.role = prefs.value.role === role ? 'all' : role
}
function toggleHealth(h: DiskHealth) {
  prefs.value.health = prefs.value.health === h ? 'all' : h
}
function clearFilters() {
  search.value = ''
  prefs.value.role = 'all'
  prefs.value.health = 'all'
}

const expanded = computed(() => new Set(prefs.value.expanded))
function toggleExpanded(name: string) {
  const e = prefs.value.expanded
  const i = e.indexOf(name)
  if (i >= 0) e.splice(i, 1)
  else e.push(name)
}

// ── Row presentation ──────────────────────────────────────────────────────────

const ROLE_CLASS: Record<DiskRole, string> = {
  system:    'bg-warning/10 text-warning border-warning/20',
  raid:      'bg-info/10 text-info border-info/20',
  lvm:       'bg-purple-500/10 text-purple-400 border-purple-500/20',
  mounted:   'bg-teal-500/10 text-teal-500 border-teal-500/20',
  free:      'bg-success/10 text-success border-success/20',
  unmounted: 'bg-[var(--c-surface-deep)] text-[var(--c-text-3)] border-[var(--c-border)]',
}

const HEALTH_DOT: Record<DiskHealth, string> = {
  passed: 'bg-success', warning: 'bg-warning', failed: 'bg-danger animate-pulse', unknown: 'bg-[var(--c-text-3)]/40',
}
const HEALTH_LABEL: Record<DiskHealth, string> = {
  passed: 'Healthy', warning: 'Warning', failed: 'Failed', unknown: 'Unknown',
}

function roleText(r: DiskRow): string {
  if (r.role === 'raid') return r.raidOwners.length ? `RAID ${r.raidOwners.join(', ')}` : 'RAID (inactive)'
  if (r.role === 'lvm')  return r.vgOwners.length ? `VG ${r.vgOwners.join(', ')}` : 'LVM (no VG)'
  return ROLE_LABELS[r.role]
}

// Arrays and VGs link to their section.
function openRole(r: DiskRow) {
  if (r.role === 'raid' || r.role === 'lvm') emit('navigate', r.role)
}

function tempClass(t: number): string {
  return t >= 55 ? 'text-danger font-semibold' : t >= 40 ? 'text-warning' : 'text-[var(--c-text-2)]'
}

const COLUMNS: { key: SortKey; label: string; class?: string }[] = [
  { key: 'name',        label: 'Device' },
  { key: 'model',       label: 'Model' },
  { key: 'serial',      label: 'Serial / WWN' },
  { key: 'size',        label: 'Size', class: 'text-right' },
  { key: 'kind',        label: 'Type' },
  { key: 'role',        label: 'Role' },
  { key: 'health',      label: 'Health' },
  { key: 'temperature', label: 'Temp', class: 'text-right' },
]

// ── Selection: free disks for a new array or volume group ─────────────────────

const selected = ref<Set<string>>(new Set())
// Drop disks that are gone or no longer free after a refresh.
watch(rows, rs => {
  const ok = new Set(rs.filter(isSelectable).map(r => r.disk.name))
  const next = new Set([...selected.value].filter(n => ok.has(n)))
  if (next.size !== selected.value.size) selected.value = next
})

function toggleSelected(name: string) {
  const s = new Set(selected.value)
  if (s.has(name)) s.delete(name)
  else s.add(name)
  selected.value = s
}

function startCreate(kind: 'raid' | 'lvm') {
  const names = [...selected.value]
  selected.value = new Set()
  emit('create', kind, names)
}

// ── Partition dialogs ─────────────────────────────────────────────────────────

const partInitDlg = ref<{ disk: BlockDev; busy: boolean; err: string } | null>(null)

async function doPartInit() {
  if (!partInitDlg.value) return
  const d = partInitDlg.value
  d.busy = true; d.err = ''
  try {
    await trpc.storage.initPartitionTable.mutate({ device: d.disk.name })
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
    await trpc.storage.createPartition.mutate({ device: d.disk.name, startPct: 0, endPct: 100 })
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
    await trpc.storage.deletePartition.mutate({ device: d.disk.name, partNum: num })
    partDeleteDlg.value = null
    await refresh()
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? 'Failed to delete partition'
  } finally {
    if (partDeleteDlg.value) d.busy = false
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
</script>

<template>
  <div>
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Devices</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Physical disks and everything built on them: partitions, RAID, LVM, filesystems.</p>
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

    <template v-if="!loading || devices.length">
      <div v-if="physicalDisks.length === 0" class="text-sm text-[var(--c-text-3)]">No physical drives detected.</div>

      <template v-else>
        <!-- Summary: each count filters the list -->
        <div class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-3 mb-3">
          <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <span class="font-semibold text-[var(--c-text-1)]">{{ summary.disks }} {{ summary.disks === 1 ? 'disk' : 'disks' }}</span>
            <span class="text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(summary.totalBytes) }} total</span>
            <span v-if="summary.roles.free" class="text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(summary.freeBytes) }} on free disks</span>
          </div>
          <div class="flex flex-wrap gap-1.5 mt-2.5">
            <template v-for="role in (['free', 'raid', 'lvm', 'mounted', 'unmounted', 'system'] as DiskRole[])" :key="role">
              <button v-if="summary.roles[role]" @click="toggleRole(role)" :aria-pressed="prefs.role === role"
                :class="['text-[11px] px-2 py-1 rounded-lg border transition-colors', ROLE_CLASS[role],
                  prefs.role === role ? 'ring-2 ring-[var(--c-accent)]/40' : 'opacity-80 hover:opacity-100']">
                {{ ROLE_LABELS[role] }} <span class="font-semibold tabular-nums">{{ summary.roles[role] }}</span>
              </button>
            </template>
            <template v-for="h in (['failed', 'warning'] as DiskHealth[])" :key="h">
              <button v-if="summary.health[h]" @click="toggleHealth(h)" :aria-pressed="prefs.health === h"
                :class="['inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg border transition-colors',
                  h === 'failed' ? 'bg-danger/10 text-danger border-danger/25' : 'bg-warning/10 text-warning border-warning/25',
                  prefs.health === h ? 'ring-2 ring-[var(--c-accent)]/40' : 'opacity-80 hover:opacity-100']">
                <span class="w-1.5 h-1.5 rounded-full" :class="HEALTH_DOT[h]"/>
                SMART {{ HEALTH_LABEL[h].toLowerCase() }} <span class="font-semibold tabular-nums">{{ summary.health[h] }}</span>
              </button>
            </template>
          </div>
        </div>

        <!-- Toolbar -->
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <input v-model="search" type="search" placeholder="Search device, model, serial…" aria-label="Search disks"
            class="flex-1 min-w-[12rem] px-3 py-1.5 text-sm rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-[var(--c-accent)] transition-colors"/>
          <select v-model="prefs.role" aria-label="Filter by role"
            class="px-2 py-1.5 text-xs rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-2)] focus:outline-none">
            <option value="all">All roles</option>
            <option v-for="(label, role) in ROLE_LABELS" :key="role" :value="role">{{ label }}</option>
          </select>
          <select v-model="prefs.health" aria-label="Filter by health"
            class="px-2 py-1.5 text-xs rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-2)] focus:outline-none">
            <option value="all">Any health</option>
            <option v-for="(label, h) in HEALTH_LABEL" :key="h" :value="h">{{ label }}</option>
          </select>
          <select :value="prefs.sortKey" @change="prefs.sortKey = ($event.target as HTMLSelectElement).value as SortKey" aria-label="Sort by"
            :class="['px-2 py-1.5 text-xs rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-2)] focus:outline-none', view === 'table' && 'sm:hidden']">
            <option v-for="c in COLUMNS" :key="c.key" :value="c.key">Sort: {{ c.label }}</option>
          </select>
          <label class="flex items-center gap-1.5 text-xs text-[var(--c-text-2)] cursor-pointer">
            <input v-model="prefs.grouped" type="checkbox" class="accent-accent"/> Group by role
          </label>
          <div class="flex rounded-lg border border-[var(--c-border)] overflow-hidden text-xs" role="group" aria-label="View">
            <button v-for="v in (['table', 'cards'] as View[])" :key="v" @click="prefs.view = v" :aria-pressed="view === v"
              :class="['px-2.5 py-1.5 transition-colors', view === v ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]' : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)]']">
              {{ v === 'table' ? 'Table' : 'Details' }}
            </button>
          </div>
        </div>

        <div v-if="filtered && visibleRows.length" class="mb-2 text-[11px] text-[var(--c-text-3)]">
          Showing {{ visibleRows.length }} of {{ summary.disks }} disks ·
          <button @click="clearFilters" class="text-[var(--c-accent)] hover:underline">Clear filters</button>
        </div>

        <!-- Selected free disks -->
        <div v-if="selected.size" class="flex flex-wrap items-center gap-2 mb-3 px-3 py-2 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-surface)] text-xs">
          <span class="text-[var(--c-text-2)]">{{ selected.size }} free {{ selected.size === 1 ? 'disk' : 'disks' }} selected</span>
          <button v-if="selected.size >= 2" @click="startCreate('raid')" class="btn btn-primary text-xs">Create RAID…</button>
          <button @click="startCreate('lvm')" class="btn btn-outline text-xs">Create volume group…</button>
          <button @click="selected = new Set()" class="ml-auto text-[var(--c-text-3)] hover:text-[var(--c-text-1)]">Clear</button>
        </div>

        <div v-if="!visibleRows.length" class="text-sm text-[var(--c-text-3)] py-6 text-center">
          No disk matches these filters. <button @click="clearFilters" class="text-[var(--c-accent)] hover:underline">Clear filters</button>
        </div>

        <!-- ═══ Table view: one compact row per disk, details on demand ═══ -->
        <div v-else-if="view === 'table'" class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] overflow-hidden">
          <!-- Header (desktop) -->
          <div class="hidden sm:grid disk-grid gap-3 px-3 py-2 border-b border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[11px] font-medium text-[var(--c-text-3)]">
            <span/>
            <button v-for="c in COLUMNS" :key="c.key" @click="setSort(c.key)"
              :aria-sort="prefs.sortKey === c.key ? (prefs.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
              :class="['text-left hover:text-[var(--c-text-1)] transition-colors truncate', c.class, prefs.sortKey === c.key && 'text-[var(--c-text-1)]']">
              {{ c.label }}<span v-if="prefs.sortKey === c.key">{{ prefs.sortDir === 'asc' ? ' ↑' : ' ↓' }}</span>
            </button>
            <span/>
          </div>

          <template v-for="g in groups" :key="g.key">
            <div v-if="g.label" class="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] bg-[var(--c-surface-deep)]/60 border-b border-[var(--c-border)]">
              {{ g.label }} <span class="font-normal">· {{ g.rows.length }}</span>
            </div>
            <div v-for="r in g.rows" :key="r.disk.name" class="border-b border-[var(--c-border)] last:border-b-0">
              <!-- Row (desktop) -->
              <div class="hidden sm:grid disk-grid gap-3 items-center px-3 py-2 text-xs cursor-pointer hover:bg-[var(--c-hover)]/40 transition-colors"
                @click="toggleExpanded(r.disk.name)">
                <input v-if="isSelectable(r)" type="checkbox" :checked="selected.has(r.disk.name)" @click.stop="toggleSelected(r.disk.name)"
                  :aria-label="`Select /dev/${r.disk.name}`" class="accent-accent"/>
                <span v-else/>
                <span class="font-mono font-semibold text-[var(--c-text-1)] truncate">/dev/{{ r.disk.name }}</span>
                <span class="text-[var(--c-text-2)] truncate" :title="r.disk.model">{{ r.disk.model || '—' }}</span>
                <span class="font-mono text-[10px] text-[var(--c-text-3)] min-w-0">
                  <span class="block truncate" :title="r.disk.serial">{{ r.disk.serial || '—' }}</span>
                  <span v-if="r.disk.wwn" class="block truncate opacity-70" :title="r.disk.wwn">{{ r.disk.wwn }}</span>
                </span>
                <span class="text-right tabular-nums text-[var(--c-text-2)]">{{ fmtBytes(r.disk.size) }}</span>
                <span class="text-[var(--c-text-3)]">{{ r.kind || '—' }}</span>
                <span class="min-w-0">
                  <button v-if="r.role === 'raid' || r.role === 'lvm'" @click.stop="openRole(r)"
                    :class="['max-w-full truncate text-[10px] px-1.5 py-0.5 rounded-sm border hover:opacity-80', ROLE_CLASS[r.role]]">{{ roleText(r) }} →</button>
                  <span v-else :class="['text-[10px] px-1.5 py-0.5 rounded-sm border', ROLE_CLASS[r.role]]">{{ roleText(r) }}</span>
                </span>
                <span class="flex items-center gap-1.5 text-[var(--c-text-2)]">
                  <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="HEALTH_DOT[r.health]"/>{{ HEALTH_LABEL[r.health] }}
                </span>
                <span class="text-right tabular-nums" :class="tempClass(r.temperature)">{{ r.temperature ? `${r.temperature}°C` : '—' }}</span>
                <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] transition-transform" :class="expanded.has(r.disk.name) && 'rotate-90'" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                </svg>
              </div>

              <!-- Row (mobile): role and health first -->
              <div class="sm:hidden flex items-start gap-2.5 px-3 py-2.5 cursor-pointer" @click="toggleExpanded(r.disk.name)">
                <input v-if="isSelectable(r)" type="checkbox" :checked="selected.has(r.disk.name)" @click.stop="toggleSelected(r.disk.name)"
                  :aria-label="`Select /dev/${r.disk.name}`" class="mt-0.5 accent-accent"/>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span :class="['text-[10px] px-1.5 py-0.5 rounded-sm border', ROLE_CLASS[r.role]]">{{ roleText(r) }}</span>
                    <span class="inline-flex items-center gap-1 text-[10px] text-[var(--c-text-2)]">
                      <span class="w-1.5 h-1.5 rounded-full" :class="HEALTH_DOT[r.health]"/>{{ HEALTH_LABEL[r.health] }}
                    </span>
                    <span v-if="r.temperature" class="text-[10px] tabular-nums" :class="tempClass(r.temperature)">{{ r.temperature }}°C</span>
                  </div>
                  <div class="mt-1 text-xs">
                    <span class="font-mono font-semibold text-[var(--c-text-1)]">/dev/{{ r.disk.name }}</span>
                    <span class="text-[var(--c-text-3)] tabular-nums"> · {{ fmtBytes(r.disk.size) }}</span>
                    <span v-if="r.kind" class="text-[var(--c-text-3)]"> · {{ r.kind }}</span>
                  </div>
                  <div class="text-[10px] text-[var(--c-text-3)] truncate">
                    {{ r.disk.model }}<span v-if="r.disk.serial" class="font-mono"> · {{ r.disk.serial }}</span>
                  </div>
                </div>
                <svg class="w-3.5 h-3.5 mt-1 text-[var(--c-text-3)] transition-transform" :class="expanded.has(r.disk.name) && 'rotate-90'" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                </svg>
              </div>

              <div v-if="expanded.has(r.disk.name)" class="px-3 pb-3">
                <DiskCard :disk="r.disk" :smart="smartCache[r.disk.name]" :smart-open="smartOpen.has(r.disk.name)"
                  :devices="devices" :lvs="lvmLVs"
                  @navigate="s => emit('navigate', s)" @toggle-smart="toggleSmart(r.disk.name)"
                  @format="openFormat" @mount="openMount" @umount="openUmount"
                  @part-init="d => partInitDlg = { disk: d, busy: false, err: '' }"
                  @part-create="d => partCreateDlg = { disk: d, busy: false, err: '' }"
                  @part-delete="(d, p) => partDeleteDlg = { disk: d, part: p, busy: false, err: '' }" />
              </div>
            </div>
          </template>
        </div>

        <!-- ═══ Detailed view: the full tree of every disk ═══ -->
        <div v-else class="space-y-3">
          <template v-for="g in groups" :key="g.key">
            <div v-if="g.label" class="pt-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">
              {{ g.label }} <span class="font-normal">· {{ g.rows.length }}</span>
            </div>
            <div v-for="r in g.rows" :key="r.disk.name" class="flex items-start gap-2">
              <input v-if="isSelectable(r)" type="checkbox" :checked="selected.has(r.disk.name)" @change="toggleSelected(r.disk.name)"
                :aria-label="`Select /dev/${r.disk.name}`" class="mt-4 accent-accent"/>
              <DiskCard class="flex-1 min-w-0" :disk="r.disk" :smart="smartCache[r.disk.name]" :smart-open="smartOpen.has(r.disk.name)"
                :devices="devices" :lvs="lvmLVs"
                @navigate="s => emit('navigate', s)" @toggle-smart="toggleSmart(r.disk.name)"
                @format="openFormat" @mount="openMount" @umount="openUmount"
                @part-init="d => partInitDlg = { disk: d, busy: false, err: '' }"
                @part-create="d => partCreateDlg = { disk: d, busy: false, err: '' }"
                @part-delete="(d, p) => partDeleteDlg = { disk: d, part: p, busy: false, err: '' }" />
            </div>
          </template>
        </div>
      </template>
    </template>

    <!-- Shared device dialogs (format / mount / unmount) -->
    <DeviceFormatWizard  ref="formatWiz" @done="refresh" @mount="d => mountDlg?.open(d)" />
    <DeviceMountDialog   ref="mountDlg"  @done="refresh" />
    <DeviceUnmountDialog ref="umountDlg" @done="refresh" />

    <!-- Create partition table -->
    <ConfirmDestroyDialog
      v-if="partInitDlg"
      title="Create partition table"
      subtitle="Writes a new GPT partition table — all existing data on the disk will be lost."
      :confirm-word="partInitDlg.disk.name"
      action-label="Create partition table"
      busy-label="Creating…"
      :busy="partInitDlg.busy"
      :error="partInitDlg.err"
      @confirm="doPartInit"
      @close="partInitDlg = null"
    >
      <template #warning>All partitions and data on <span class="font-mono font-bold">/dev/{{ partInitDlg.disk.name }}</span> will be permanently destroyed. This cannot be undone.</template>
      <template #details>
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Disk</span><span class="font-mono">/dev/{{ partInitDlg.disk.name }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(partInitDlg.disk.size) }}</span></div>
        <div v-if="partInitDlg.disk.model" class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Model</span><span>{{ partInitDlg.disk.model }}</span></div>
        <div v-if="partInitDlg.disk.serial" class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Serial</span><span class="font-mono">{{ partInitDlg.disk.serial }}</span></div>
      </template>
    </ConfirmDestroyDialog>

    <!-- Add partition -->
    <Modal v-if="partCreateDlg" panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!partCreateDlg.busy" @close="partCreateDlg = null">
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
              <button @click="partCreateDlg = null" class="btn btn-outline flex-1 justify-center">Cancel</button>
              <button @click="doPartCreate" :disabled="partCreateDlg.busy"
                class="btn btn-primary flex-1 justify-center">
                <span v-if="partCreateDlg.busy">Creating…</span>
                <span v-else>Create partition</span>
              </button>
            </div>
          </div>
    </Modal>

    <!-- Delete partition -->
    <ConfirmDestroyDialog
      v-if="partDeleteDlg"
      title="Delete partition"
      action-label="Delete partition"
      busy-label="Deleting…"
      :busy="partDeleteDlg.busy"
      :error="partDeleteDlg.err"
      @confirm="doPartDelete"
      @close="partDeleteDlg = null"
    >
      <template #warning>Deleting <span class="font-mono font-bold">/dev/{{ partDeleteDlg.part.name }}</span> will permanently destroy all data in that partition.</template>
      <template #details>
        <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Partition</span><span class="font-mono">/dev/{{ partDeleteDlg.part.name }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(partDeleteDlg.part.size) }}</span></div>
        <div v-if="partDeleteDlg.part.fstype" class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Filesystem</span><span class="font-mono">{{ partDeleteDlg.part.fstype }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Disk</span><span class="font-mono">/dev/{{ partDeleteDlg.disk.name }}</span><span v-if="partDeleteDlg.disk.model" class="text-[var(--c-text-3)]">{{ partDeleteDlg.disk.model }}</span></div>
        <div v-if="partDeleteDlg.disk.serial" class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Serial</span><span class="font-mono">{{ partDeleteDlg.disk.serial }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Partition #</span><span class="font-mono">{{ partNumOf(partDeleteDlg.disk.name, partDeleteDlg.part.name) }}</span></div>
      </template>
    </ConfirmDestroyDialog>

  </div>
</template>

<style scoped>
/* select · device · model · serial · size · type · role · health · temp · chevron */
.disk-grid {
  grid-template-columns: 1rem minmax(6.5rem, 1fr) minmax(7rem, 1.4fr) minmax(7rem, 1.2fr) 4.5rem 3.5rem minmax(6.5rem, 1fr) 5rem 3rem 0.875rem;
}
</style>
