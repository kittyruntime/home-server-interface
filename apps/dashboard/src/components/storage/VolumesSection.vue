<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Card } from '@/components/ui/card'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import LoadingState from '../ui/LoadingState.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DescriptionCard from './DescriptionCard.vue'
import { unlistedDrift } from './description'
import { useStorageData, fmtBytes } from './store'
import { smartStatus, sharedSmart, readSmartList } from './smart'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { Button } from '@/components/ui/button'
import Tip from '../ui/Tip.vue'

const { t } = useI18n()

// The Storage landing page (#40): where the data lives. One row per volume
// (a data filesystem, mounted, not mounted or missing at boot), with its
// redundancy, space, health and what uses it.

type Overview = Awaited<ReturnType<typeof trpc.storage.volumes.overview.query>>
type Volume = Overview['volumes'][number]

const emit = defineEmits<{
  navigate: [target: StorageSection | StorageLocation]
}>()

const overview = ref<Overview | null>(null)
const loading  = ref(true)
const error    = ref('')
const { devices, refresh: refreshDevices } = useStorageData({ autoRefresh: false })

// Storage from another machine or an earlier install, not running here (#6).
const found = ref<{ arrays: number; vgs: number }>({ arrays: 0, vgs: 0 })
async function loadFound() {
  try {
    const s = await trpc.storage.importScan.query()
    found.value = { arrays: s.arrays.length, vgs: s.vgs.length }
  } catch { found.value = { arrays: 0, vgs: 0 } }
}

// Described volumes that differ and are not listed below (#37): their array
// is stopped or their fstab entry is gone, so Reapply is offered here.
type DescStatus = Awaited<ReturnType<typeof trpc.storage.volumes.descriptions.query>>[number]
const descriptions = ref<DescStatus[]>([])
async function loadDescriptions() {
  try { descriptions.value = await trpc.storage.volumes.descriptions.query() } catch { descriptions.value = [] }
}

async function load() {
  error.value = ''
  void loadFound()
  void loadDescriptions()
  try {
    overview.value = await trpc.storage.volumes.overview.query()
    void loadSmart()
  } catch (e) {
    // A failed reload keeps the list shown; the error appears above it.
    error.value = e instanceof Error ? e.message : 'Could not read the volumes'
  } finally {
    loading.value = false
  }
}
onMounted(load)

// SMART of the disks under the volumes, read without waking sleeping disks,
// shared with the Disks list and stopped when the page is left.
const smart = sharedSmart
let left = false
onUnmounted(() => { left = true })
async function loadSmart() {
  const names = [...new Set((overview.value?.volumes ?? []).flatMap(v => v.disks.map(d => d.name)))]
  await readSmartList(names, () => left)
}
function smartIssue(v: Volume): string | null {
  for (const d of v.disks) {
    const st = smartStatus(smart.value[d.name])
    if (st === 'failed')  return t('uis.storage.VolumesSection.smartFailedOn', { p0: d.name })
    if (st === 'warning') return t('uis.storage.VolumesSection.smartWarningOn', { p0: d.name })
  }
  return null
}

type Health = 'ok' | 'idle' | 'warning' | 'danger'
function health(v: Volume): { level: Health; text: string } {
  if (v.state === 'missing') return { level: 'danger', text: v.issues[0]?.text ?? t('uis.storage.VolumesSection.missing') }
  const bad = v.issues.find(i => i.kind === 'degraded' || i.kind === 'blocked')
  if (bad) return { level: 'danger', text: bad.text }
  const smartText = smartIssue(v)
  if (smartText?.startsWith('SMART failed')) return { level: 'danger', text: smartText }
  const warn = v.issues[0]
  if (warn) return { level: 'warning', text: warn.text }
  if (smartText) return { level: 'warning', text: smartText }
  if (v.state === 'not-mounted') return { level: 'idle', text: t('uis.storage.VolumesSection.notMounted') }
  return { level: 'ok', text: t('uis.storage.VolumesSection.healthy') }
}
const HEALTH_DOT: Record<Health, string> = { ok: 'bg-success', idle: 'bg-muted-foreground', warning: 'bg-warning', danger: 'bg-destructive' }
const HEALTH_TEXT: Record<Health, string> = { ok: 'text-foreground/80', idle: 'text-muted-foreground', warning: 'text-warning', danger: 'text-destructive' }

const REDUNDANCY: Record<string, string> = {
  none: 'No redundancy', raid0: 'Striped, no redundancy', raid1: 'Mirror',
  raid4: 'RAID 4', raid5: 'RAID 5', raid6: 'RAID 6', raid10: 'RAID 10',
}

function usedByText(v: Volume): string {
  const parts: string[] = []
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  if (v.usedBy.places.length) parts.push(n(v.usedBy.places.length, 'Place', 'Places'))
  if (v.usedBy.shares.length) parts.push(n(v.usedBy.shares.length, 'share', 'shares'))
  if (v.usedBy.apps.length)   parts.push(v.usedBy.apps.length <= 2 ? v.usedBy.apps.join(', ') : n(v.usedBy.apps.length, 'app', 'apps'))
  return parts.join(', ') || 'Not used'
}
const usedPct = (v: Volume) => v.space ? Math.round((v.space.used / v.space.total) * 100) : 0

// Sort by name, space used or health (worst first).
type SortKey = 'name' | 'space' | 'health'
const sortKey = ref<SortKey>('health')
const HEALTH_RANK: Record<Health, number> = { danger: 0, warning: 1, idle: 2, ok: 3 }
const unlisted = computed(() => unlistedDrift(descriptions.value, (overview.value?.volumes ?? []).map(v => v.mountPoint ?? '')))

const volumes = computed(() => {
  const vs = [...(overview.value?.volumes ?? [])]
  if (sortKey.value === 'name')   vs.sort((a, b) => a.name.localeCompare(b.name))
  if (sortKey.value === 'space')  vs.sort((a, b) => usedPct(b) - usedPct(a))
  if (sortKey.value === 'health') vs.sort((a, b) => HEALTH_RANK[health(a).level] - HEALTH_RANK[health(b).level] || a.name.localeCompare(b.name))
  return vs
})

const diskCount = computed(() => new Set([
  ...(overview.value?.volumes ?? []).flatMap(v => v.disks.map(d => d.name)),
  ...(overview.value?.freeDisks ?? []).map(d => d.name),
]).size)
const warnings = computed(() => (overview.value?.volumes ?? []).filter(v => health(v).level === 'warning' || health(v).level === 'danger').length)

function openVolume(v: Volume) {
  emit('navigate', { kind: 'volume', id: v.id })
}

function createVolume() {
  emit('navigate', { kind: 'create-volume' })
}

const mountDlg = ref<InstanceType<typeof DeviceMountDialog> | null>(null)
async function mount(v: Volume) {
  if (!devices.value.length) await refreshDevices()
  const find = (list: typeof devices.value): (typeof devices.value)[number] | undefined => {
    for (const d of list) {
      if (d.name === v.device) return d
      const c = find(d.children ?? [])
      if (c) return c
    }
    return undefined
  }
  const dev = find(devices.value)
  if (dev) mountDlg.value?.open(dev)
  else void load() // the device has gone since the list loaded
}
</script>

<template>
  <div>
    <div class="flex items-start justify-between gap-4 mb-5">
      <div class="min-w-0">
        <h2 class="text-lg font-semibold text-foreground">{{ t('ui.storage.VolumesSection.volumes') }}</h2>
        <p v-if="overview" class="text-sm text-muted-foreground mt-0.5">
          {{ overview.volumes.length }} {{ overview.volumes.length === 1 ? 'volume' : 'volumes' }}
          · {{ diskCount }} {{ diskCount === 1 ? 'disk' : 'disks' }}
          <span v-if="warnings" class="text-warning"> · {{ warnings }} {{ warnings === 1 ? 'needs attention' : 'need attention' }}</span>
        </p>
      </div>
      <Tip :text="overview && !overview.freeDisks.length ? 'No free disk: connect a disk to create a volume' : undefined" wrap>
        <Button size="sm" class="shrink-0" :disabled="!overview?.freeDisks.length" @click="createVolume">{{ t('ui.storage.VolumesSection.createVolume') }}</Button>
      </Tip>
    </div>

    <Alert variant="info" v-if="found.arrays || found.vgs" class="mb-4 flex flex-wrap items-center justify-between gap-3" role="note">
      <p class="text-sm text-foreground">
        {{ t('ui.storage.VolumesSection.existingStorageWasFoundOn') }}
        <template v-if="found.arrays">{{ found.arrays }} {{ found.arrays === 1 ? 'array' : 'arrays' }}</template><template v-if="found.arrays && found.vgs"> and </template><template v-if="found.vgs">{{ found.vgs }} inactive {{ found.vgs === 1 ? 'volume group' : 'volume groups' }}</template>{{ t('ui.storage.VolumesSection.importingKeepsItsData') }}
      </p>
      <Button variant="outline" size="sm" class="shrink-0" @click="emit('navigate', found.arrays ? 'raid' : 'lvm')">{{ t('ui.storage.VolumesSection.reviewAndImport') }}</Button>
    </Alert>

    <div v-for="d in unlisted" :key="d.mountPoint" class="mb-4">
      <DescriptionCard :mount-point="d.mountPoint" titled @changed="load" />
    </div>

    <LoadingState v-if="loading" />
    <p v-if="error" role="alert" class="status-text text-destructive mb-3"><span class="status-tag">[ERR]</span> {{ error }}</p>

    <template v-if="!loading && overview">
      <Card v-if="!volumes.length" class="block gap-0 py-0 shadow-none px-4 py-8 text-center text-sm text-muted-foreground">
        {{ t('ui.storage.VolumesSection.noDataVolumeYetCreate') }}
      </Card>

      <Card v-else class="block gap-0 py-0 shadow-none overflow-hidden">
        <!-- Header (wide) -->
        <div class="hidden @3xl/content:grid vol-grid gap-3 px-4 py-2 border-b border-border bg-muted text-2xs font-medium text-muted-foreground">
          <Button variant="link" class="h-auto p-0 text-left hover:text-foreground" :class="sortKey === 'name' && 'text-foreground'" @click="sortKey = 'name'">{{ t('ui.storage.VolumesSection.volume') }}</Button>
          <span>{{ t('ui.storage.VolumesSection.redundancy') }}</span>
          <Button variant="link" class="h-auto p-0 text-left hover:text-foreground" :class="sortKey === 'space' && 'text-foreground'" @click="sortKey = 'space'">{{ t('ui.storage.VolumesSection.space') }}</Button>
          <Button variant="link" class="h-auto p-0 text-left hover:text-foreground" :class="sortKey === 'health' && 'text-foreground'" @click="sortKey = 'health'">{{ t('ui.storage.VolumesSection.health') }}</Button>
          <span>{{ t('ui.storage.VolumesSection.usedBy') }}</span>
        </div>

        <div v-for="v in volumes" :key="v.id" class="border-b border-border last:border-b-0">
          <!-- Row (wide) -->
          <div class="hidden @3xl/content:grid vol-grid gap-3 items-center px-4 py-3 text-xs cursor-pointer hover:bg-accent transition-colors" @click="openVolume(v)">
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium text-foreground">{{ v.name }}</span>
              <span class="block truncate font-mono text-2xs text-muted-foreground">{{ v.mountPoint ?? `/dev/${v.device}` }}</span>
            </span>
            <span class="text-foreground/80">{{ REDUNDANCY[v.redundancy] }}</span>
            <span class="min-w-0">
              <template v-if="v.space">
                <Progress class="h-1.5 rounded-full bg-accent" :model-value="usedPct(v)" :indicator-class="['rounded-full', usedPct(v) > 90 ? 'bg-warning' : 'bg-foreground']" />
                <span class="block mt-1 font-mono tabular-nums text-2xs text-foreground/80">{{ fmtBytes(v.space.used) }} / {{ fmtBytes(v.space.total) }}</span>
              </template>
              <Button variant="outline" size="xs" v-else-if="v.state === 'not-mounted'" @click.stop="mount(v)">{{ t('ui.storage.VolumesSection.mount') }}</Button>
              <span v-else class="text-muted-foreground">-</span>
            </span>
            <span class="flex items-center gap-1.5 min-w-0" :class="HEALTH_TEXT[health(v).level]">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="HEALTH_DOT[health(v).level]" />
              <span class="truncate" :title="health(v).text">{{ health(v).text }}</span>
            </span>
            <span class="truncate text-muted-foreground" :title="usedByText(v)">{{ usedByText(v) }}</span>
          </div>

          <!-- Card (narrow) -->
          <div class="@3xl/content:hidden px-4 py-3 cursor-pointer" @click="openVolume(v)">
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0">
                <span class="block truncate text-sm font-medium text-foreground">{{ v.name }}</span>
                <span class="block truncate font-mono text-2xs text-muted-foreground">{{ v.mountPoint ?? `/dev/${v.device}` }}</span>
              </span>
              <span class="flex items-center gap-1.5 text-xs shrink-0" :class="HEALTH_TEXT[health(v).level]">
                <span class="w-1.5 h-1.5 rounded-full" :class="HEALTH_DOT[health(v).level]" />{{ health(v).text }}
              </span>
            </div>
            <div v-if="v.space" class="mt-2">
              <Progress class="h-1.5 rounded-full bg-accent" :model-value="usedPct(v)" :indicator-class="['rounded-full', usedPct(v) > 90 ? 'bg-warning' : 'bg-foreground']" />
            </div>
            <div class="mt-1.5 flex items-center justify-between gap-2 text-2xs text-muted-foreground">
              <span>{{ REDUNDANCY[v.redundancy] }} · {{ usedByText(v) }}</span>
              <span v-if="v.space" class="font-mono tabular-nums">{{ fmtBytes(v.space.used) }} / {{ fmtBytes(v.space.total) }}</span>
              <Button variant="outline" size="xs" v-else-if="v.state === 'not-mounted'" @click.stop="mount(v)">{{ t('ui.storage.VolumesSection.mount') }}</Button>
            </div>
          </div>
        </div>
      </Card>

      <div class="mt-4 space-y-1.5 text-xs text-muted-foreground">
        <p v-if="overview.freeDisks.length">
          {{ t('ui.storage.VolumesSection.freeDisks') }}
          <span class="font-mono text-foreground/80">{{ overview.freeDisks.map(d => `${d.name} ${fmtBytes(d.size)}`).join(' · ') }}</span>
          <Button variant="link" class="h-auto p-0 ml-1.5 text-foreground" @click="createVolume">{{ t('ui.storage.VolumesSection.createVolume2') }}</Button>
        </p>
        <p v-if="overview.system">
          {{ t('ui.storage.VolumesSection.system') }} <span class="font-mono text-foreground/80">/ · {{ fmtBytes(overview.system.free) }} free of {{ fmtBytes(overview.system.total) }}</span>
        </p>
      </div>
    </template>

    <DeviceMountDialog ref="mountDlg" @done="load" />
  </div>
</template>

<style scoped>
.vol-grid {
  grid-template-columns: minmax(10rem, 1.4fr) minmax(7rem, 0.9fr) minmax(9rem, 1.2fr) minmax(8rem, 1fr) minmax(7rem, 1fr);
}
</style>
