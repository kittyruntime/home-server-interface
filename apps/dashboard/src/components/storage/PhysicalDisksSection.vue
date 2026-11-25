<script setup lang="ts">
import DiskBays from './DiskBays.vue'
import StorageIntro from './StorageIntro.vue'
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Toggle } from '@/components/ui/toggle'
import { Badge } from '@/components/ui/badge'
import SortableHeader from '../ui/SortableHeader.vue'
import { ChevronRightIcon, RefreshCwIcon } from '@lucide/vue'
import type { StorageLocation } from '../../lib/storage-nav'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import LoadingState from '../ui/LoadingState.vue'
import { trpc } from '../../lib/trpc'
import { ref, computed, watch } from 'vue'
import { useAuth } from '../../lib/auth'
import { useStorageData, fmtBytes, type BlockDev } from './store'
import { type SmartResult, smartStatus, fetchSmartInto, sharedSmart } from './smart'
import {
  diskRow, summarize, filterRows, sortRows, usedBy,
  type DiskRow, type DiskHealth, type SortKey, type SortDir,
} from './disk-list'
import type { BayOwner } from './disk-bays'
import DiskLabel from './DiskLabel.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

// The Disks tab: the server's disks as hardware (identity, health,
// temperature, label) and what uses each one. Building on them (partitions,
// formatting, arrays, pools) happens in the LVM and ZFS tabs.
const { t } = useI18n()

const emit = defineEmits<{
  open:     [disk: string]
  navigate: [target: 'raid' | 'lvm' | 'pools' | StorageLocation]
  // Start creating a volume on these free disks.
  create:   [kind: 'raid' | 'lvm' | 'volume', devices: string[]]
}>()

const { loading, error, devices, refresh } = useStorageData()
const { currentUsername } = useAuth()

// Every disk's health is read when the list loads, without waking disks in
// standby (they show as unknown until their page is opened).
const smartCache = sharedSmart
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

// Disk labels by serial (#32).
const labels = ref<Record<string, string>>({})
async function loadLabels() {
  try {
    labels.value = Object.fromEntries((await trpc.storage.diskLabels.list.query()).map(l => [l.serial, l.label]))
  } catch { /* labels are optional; the list works without them */ }
}
void loadLabels()
function setLabel(serial: string | undefined, label: string) {
  if (!serial) return
  const next = { ...labels.value }
  if (label) next[serial] = label
  else delete next[serial]
  labels.value = next
}

const rows = computed<DiskRow<BlockDev>[]>(() => physicalDisks.value.map(d => {
  const s = smartCache.value[d.name]
  return diskRow(d, s && { health: healthOf(s), temperature: s.temperature, rotationRate: s.rotationRate, available: s.available },
    d.serial ? labels.value[d.serial] ?? '' : '')
}))
const summary = computed(() => summarize(rows.value))

// ── Filters and sort (remembered per user in this browser) ───────────────────

type Prefs = { sortKey: SortKey; sortDir: SortDir; usedBy: BayOwner | 'all'; health: DiskHealth | 'all' }
const PREFS_KEY = computed(() => `hsi.storage.devices.${currentUsername.value ?? ''}`)

function loadPrefs(): Prefs {
  const defaults: Prefs = { sortKey: 'name', sortDir: 'asc', usedBy: 'all', health: 'all' }
  try {
    const raw = localStorage.getItem(PREFS_KEY.value)
    const p = raw ? JSON.parse(raw) as Partial<Prefs> : {}
    return { ...defaults, sortKey: p.sortKey ?? defaults.sortKey, sortDir: p.sortDir ?? defaults.sortDir, usedBy: p.usedBy ?? 'all', health: p.health ?? 'all' }
  } catch {
    return defaults
  }
}

const prefs = ref<Prefs>(loadPrefs())
watch(prefs, p => {
  try { localStorage.setItem(PREFS_KEY.value, JSON.stringify(p)) } catch { /* private mode: not remembered */ }
}, { deep: true })

const search = ref('')
const OWNERS: BayOwner[] = ['lvm', 'zfs', 'free', 'system', 'other']
const ownerCount = computed(() => Object.fromEntries(OWNERS.map(o => [o, rows.value.filter(r => usedBy(r).owner === o).length])) as Record<BayOwner, number>)

const visibleRows = computed(() => sortRows(
  filterRows(rows.value, { search: search.value, role: 'all', health: prefs.value.health })
    .filter(r => prefs.value.usedBy === 'all' || usedBy(r).owner === prefs.value.usedBy),
  prefs.value.sortKey, prefs.value.sortDir))
const filtered = computed(() => !!search.value || prefs.value.usedBy !== 'all' || prefs.value.health !== 'all')

function setSort(key: SortKey) {
  const p = prefs.value
  if (p.sortKey === key) p.sortDir = p.sortDir === 'asc' ? 'desc' : 'asc'
  else { p.sortKey = key; p.sortDir = 'asc' }
}
function toggleOwner(o: BayOwner) {
  prefs.value.usedBy = prefs.value.usedBy === o ? 'all' : o
}
function toggleHealth(h: DiskHealth) {
  prefs.value.health = prefs.value.health === h ? 'all' : h
}
function clearFilters() {
  search.value = ''
  prefs.value.usedBy = 'all'
  prefs.value.health = 'all'
}

// ── Row presentation ──────────────────────────────────────────────────────────

const OWNER_CLASS: Record<BayOwner, string> = {
  lvm:    'bg-secondary/10 text-secondary border-secondary/30',
  zfs:    'bg-engine-zfs/10 text-engine-zfs border-engine-zfs/30',
  free:   'bg-success/10 text-success border-success/20',
  system: 'bg-warning/10 text-warning border-warning/20',
  other:  'bg-base-200 text-base-content/70 border-base-300',
}
const HEALTH_DOT: Record<DiskHealth, string> = {
  passed: 'bg-success', warning: 'bg-warning', failed: 'bg-error animate-pulse', unknown: 'bg-base-content/30',
}
const HEALTH_LABEL: Record<DiskHealth, string> = {
  passed: t('ui.storage.PhysicalDisksSection.healthPassed'), warning: t('ui.storage.PhysicalDisksSection.healthWarning'),
  failed: t('ui.storage.PhysicalDisksSection.healthFailed'), unknown: t('ui.storage.PhysicalDisksSection.healthUnknown'),
}

function openUser(r: DiskRow) {
  const u = usedBy(r)
  if (u.target) emit('navigate', u.target)
}

function tempClass(t: number): string {
  return t >= 55 ? 'text-error font-semibold' : t >= 40 ? 'text-warning' : 'text-base-content/80'
}

const COLUMNS: { key: SortKey; label: string; class?: string }[] = [
  { key: 'name',        label: t('uis.storage.PhysicalDisksSection.device') },
  { key: 'model',       label: t('uis.storage.PhysicalDisksSection.model') },
  { key: 'serial',      label: t('uis.storage.PhysicalDisksSection.serialWwn') },
  { key: 'size',        label: t('uis.storage.PhysicalDisksSection.size'), class: 'text-right' },
  { key: 'kind',        label: t('uis.storage.PhysicalDisksSection.type') },
  { key: 'role',        label: t('ui.storage.PhysicalDisksSection.usedBy') },
  { key: 'health',      label: t('uis.storage.PhysicalDisksSection.health') },
  { key: 'temperature', label: t('uis.storage.PhysicalDisksSection.temp'), class: 'text-right' },
]
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mb-4">
      <div class="min-w-0 flex-1 basis-56">
        <h2 class="text-lg font-semibold text-base-content">{{ t('ui.storage.PhysicalDisksSection.disks') }}</h2>
        <p class="text-sm text-base-content/70 mt-0.5">{{ t('ui.storage.PhysicalDisksSection.hardwareSubtitle') }}</p>
      </div>
      <Button variant="ghost" size="icon-sm" @click="refresh" :disabled="loading" :tooltip="t('ui.storage.PhysicalDisksSection.refresh')" :aria-label="t('ui.storage.PhysicalDisksSection.refresh')" class="text-base-content/70 hover:text-base-content">
        <LoadingSpinner v-if="loading" class="text-base" />
        <RefreshCwIcon v-else class="w-4 h-4" aria-hidden="true" />
      </Button>
    </div>

    <StorageIntro tab="disks" />

    <DiskBays v-if="rows.length" :rows="rows" @create="disks => emit('create', 'volume', disks)" @open="n => emit('open', n)" />

    <LoadingState v-if="loading && !devices.length" variant="block" />
    <Alert variant="destructive" v-else-if="error" class="mt-4"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <template v-if="!loading || devices.length">
      <div v-if="physicalDisks.length === 0" class="text-sm text-base-content/70">{{ t('ui.storage.PhysicalDisksSection.noPhysicalDrivesDetected') }}</div>

      <template v-else>
        <!-- Summary: each count filters the list -->
        <Card class="block gap-0 py-0 shadow-none px-4 py-3 mb-3">
          <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <span class="font-semibold text-base-content">{{ t('ui.storage.PhysicalDisksSection.disksCount', summary.disks) }}</span>
            <span class="text-base-content/70 tabular-nums">{{ t('ui.storage.PhysicalDisksSection.total', { size: fmtBytes(summary.totalBytes) }) }}</span>
            <span v-if="summary.roles.free" class="text-base-content/70 tabular-nums">{{ t('uip.storage.PhysicalDisksSection.onFreeDisks', { p0: fmtBytes(summary.freeBytes) }) }}</span>
          </div>
          <div class="flex flex-wrap gap-1.5 mt-2.5">
            <template v-for="o in OWNERS" :key="o">
              <Toggle v-if="ownerCount[o]" variant="outline" size="sm" class="h-7 text-xs"
                :model-value="prefs.usedBy === o" @update:model-value="toggleOwner(o)">
                {{ t(`ui.storage.DiskBays.owner.${o}`) }}
                <span :class="['rounded-sm border px-1 text-2xs font-semibold tabular-nums', OWNER_CLASS[o]]">{{ ownerCount[o] }}</span>
              </Toggle>
            </template>
            <template v-for="h in (['failed', 'warning'] as DiskHealth[])" :key="h">
              <Toggle v-if="summary.health[h]" variant="outline" size="sm"
                :class="['h-7 text-xs', h === 'failed' ? 'text-error' : 'text-warning']"
                :model-value="prefs.health === h" @update:model-value="toggleHealth(h)">
                <span class="w-1.5 h-1.5 rounded-full" :class="HEALTH_DOT[h]" />
                SMART {{ HEALTH_LABEL[h].toLowerCase() }} <span class="font-semibold tabular-nums">{{ summary.health[h] }}</span>
              </Toggle>
            </template>
          </div>
        </Card>

        <!-- Toolbar -->
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <Input v-model="search" type="search" :placeholder="t('ui.storage.PhysicalDisksSection.searchDeviceModelSerial')" :aria-label="t('ui.storage.PhysicalDisksSection.searchDisks')"
            class="flex-1 min-w-[12rem] px-3 py-1.5 text-sm placeholder-base-content/70" />
          <NativeSelect wrapper-class="w-auto" v-model="prefs.usedBy" :aria-label="t('ui.storage.PhysicalDisksSection.filterByUsedBy')"
            class="px-2 py-1.5 text-xs">
            <NativeSelectOption value="all">{{ t('ui.storage.PhysicalDisksSection.usedByAll') }}</NativeSelectOption>
            <NativeSelectOption v-for="o in OWNERS" :key="o" :value="o">{{ t(`ui.storage.DiskBays.owner.${o}`) }}</NativeSelectOption>
          </NativeSelect>
          <NativeSelect wrapper-class="w-auto" v-model="prefs.health" :aria-label="t('ui.storage.PhysicalDisksSection.filterByHealth')"
            class="px-2 py-1.5 text-xs">
            <NativeSelectOption value="all">{{ t('ui.storage.PhysicalDisksSection.anyHealth') }}</NativeSelectOption>
            <NativeSelectOption v-for="(label, h) in HEALTH_LABEL" :key="h" :value="h">{{ label }}</NativeSelectOption>
          </NativeSelect>
          <NativeSelect :model-value="prefs.sortKey" @update:model-value="key => prefs.sortKey = key as SortKey" :aria-label="t('ui.storage.PhysicalDisksSection.sortBy')"
            wrapper-class="w-auto @4xl/content:hidden" class="px-2 py-1.5 text-xs">
            <NativeSelectOption v-for="c in COLUMNS" :key="c.key" :value="c.key">{{ t('uip.storage.PhysicalDisksSection.sort', { p0: c.label }) }}</NativeSelectOption>
          </NativeSelect>
        </div>

        <div v-if="filtered && visibleRows.length" class="mb-2 text-2xs text-base-content/70">
          {{ t('uip.storage.PhysicalDisksSection.showingOfDisks', { p0: visibleRows.length, p1: summary.disks }) }}
          <Button variant="link" @click="clearFilters" class="h-auto p-0 text-primary">{{ t('ui.storage.PhysicalDisksSection.clearFilters') }}</Button>
        </div>

        <div v-if="!visibleRows.length" class="text-sm text-base-content/70 py-6 text-center">
          {{ t('ui.storage.PhysicalDisksSection.noDiskMatchesTheseFilters') }} <Button variant="link" @click="clearFilters" class="h-auto p-0 text-primary">{{ t('ui.storage.PhysicalDisksSection.clearFilters') }}</Button>
        </div>

        <!-- One row per disk; the row opens the disk's page -->
        <Card v-else class="block gap-0 py-0 shadow-none overflow-hidden">
          <div class="hidden @4xl/content:grid disk-grid gap-3 px-3 py-2 border-b border-base-300 bg-base-200 text-2xs font-medium text-base-content/70">
            <span v-for="c in COLUMNS" :key="c.key" :class="['min-w-0', c.class]"
              :aria-sort="prefs.sortKey === c.key ? (prefs.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'">
              <SortableHeader :active="prefs.sortKey === c.key" :dir="prefs.sortDir" :class="['max-w-full truncate', prefs.sortKey === c.key && 'text-base-content']" @click="setSort(c.key)">
                {{ c.label }}
              </SortableHeader>
            </span>
            <span />
          </div>

          <div v-for="r in visibleRows" :key="r.disk.name" :data-disk="r.disk.name" class="border-b border-base-300 last:border-b-0">
            <!-- Row (desktop) -->
            <div class="group hidden @4xl/content:grid disk-grid gap-3 items-center px-3 py-2 text-xs cursor-pointer hover:bg-base-200/40 transition-colors"
              @click="emit('open', r.disk.name)">
              <span class="min-w-0">
                <span class="block font-mono font-semibold text-base-content truncate">/dev/{{ r.disk.name }}</span>
                <DiskLabel :serial="r.disk.serial" :label="r.label" @saved="l => setLabel(r.disk.serial, l)" @click.stop />
              </span>
              <span class="text-base-content/80 truncate" :title="r.disk.model">{{ r.disk.model || '-' }}</span>
              <span class="font-mono text-2xs text-base-content/70 min-w-0">
                <span class="block truncate" :title="r.disk.serial">{{ r.disk.serial || '-' }}</span>
                <span v-if="r.disk.wwn" class="block truncate opacity-70" :title="r.disk.wwn">{{ r.disk.wwn }}</span>
              </span>
              <span class="text-right tabular-nums text-base-content/80">{{ fmtBytes(r.disk.size) }}</span>
              <span class="text-base-content/70">{{ r.kind || '-' }}</span>
              <span class="min-w-0">
                <Badge v-if="usedBy(r).target" as="button" variant="outline" @click.stop="openUser(r)"
                  :class="['max-w-full truncate rounded-sm hover:opacity-80', OWNER_CLASS[usedBy(r).owner]]">{{ usedBy(r).text }} →</Badge>
                <span v-else :class="['text-2xs px-1.5 py-0.5 rounded-sm border', OWNER_CLASS[usedBy(r).owner]]">{{ usedBy(r).text }}</span>
              </span>
              <span class="flex items-center gap-1.5 text-base-content/80">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="HEALTH_DOT[r.health]" />{{ HEALTH_LABEL[r.health] }}
              </span>
              <span class="text-right tabular-nums" :class="tempClass(r.temperature)">{{ r.temperature ? `${r.temperature}°C` : '-' }}</span>
              <ChevronRightIcon class="w-3.5 h-3.5 text-base-content/70" aria-hidden="true" />
            </div>

            <!-- Row (mobile) -->
            <div class="group @4xl/content:hidden flex items-start gap-2.5 px-3 py-2.5 cursor-pointer" @click="emit('open', r.disk.name)">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <Badge v-if="usedBy(r).target" as="button" variant="outline" @click.stop="openUser(r)"
                    :class="['rounded-sm text-2xs', OWNER_CLASS[usedBy(r).owner]]">{{ usedBy(r).text }} →</Badge>
                  <span v-else :class="['text-2xs px-1.5 py-0.5 rounded-sm border', OWNER_CLASS[usedBy(r).owner]]">{{ usedBy(r).text }}</span>
                  <span class="inline-flex items-center gap-1 text-2xs text-base-content/80">
                    <span class="w-1.5 h-1.5 rounded-full" :class="HEALTH_DOT[r.health]" />{{ HEALTH_LABEL[r.health] }}
                  </span>
                  <span v-if="r.temperature" class="text-2xs tabular-nums" :class="tempClass(r.temperature)">{{ r.temperature }}°C</span>
                </div>
                <div class="mt-1 text-xs">
                  <span class="font-mono font-semibold text-base-content">/dev/{{ r.disk.name }}</span>
                  <span class="text-base-content/70 tabular-nums"> · {{ fmtBytes(r.disk.size) }}</span>
                  <span v-if="r.kind" class="text-base-content/70"> · {{ r.kind }}</span>
                </div>
                <div class="text-2xs text-base-content/70 truncate">
                  {{ r.disk.model }}<span v-if="r.disk.serial"> · {{ r.disk.serial }}</span>
                </div>
                <DiskLabel :serial="r.disk.serial" :label="r.label" @saved="l => setLabel(r.disk.serial, l)" @click.stop />
              </div>
              <ChevronRightIcon class="w-3.5 h-3.5 mt-1 text-base-content/70" aria-hidden="true" />
            </div>
          </div>
        </Card>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* device · model · serial · size · type · used by · health · temp · chevron */
.disk-grid {
  grid-template-columns: minmax(6.5rem, 1fr) minmax(7rem, 1.4fr) minmax(7rem, 1.2fr) 4.5rem 3.5rem minmax(6.5rem, 1fr) 5rem 3rem 0.875rem;
}
</style>
