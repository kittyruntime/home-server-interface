<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronRightIcon, DatabaseIcon, FolderTreeIcon, HardDriveIcon, Layers3Icon, TriangleAlertIcon, CircleCheckIcon } from '@lucide/vue'
import { trpc } from '../../lib/trpc'
import { Card } from '@/components/ui/card'
import LoadingState from '../ui/LoadingState.vue'
import TypeBadge from './TypeBadge.vue'
import { useStorageData, fmtBytes } from './store'
import { sharedSmart, fetchSmartInto, smartStatus } from './smart'
import { loadZfs, zfs } from './zfs-data'
import { poolRows, storageFacts, type PoolRow } from './storage-model'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'

// What the server stores, what is well and what needs attention: a summary
// of the other sections, with links to them. No action here.
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation] }>()
const { t } = useI18n()
const { loading, raids, devices, lvmPVs, lvmVGs } = useStorageData()
type Overview = Awaited<ReturnType<typeof trpc.storage.volumes.overview.query>>
const overview = ref<Overview | null>(null)
const failed = ref('')
onMounted(async () => {
  void loadZfs()
  try { overview.value = await trpc.storage.volumes.overview.query() } catch (e) { failed.value = (e as Error).message || 'error' }
})

// Disk health as the Disks section reads it (disks in standby are not woken).
const disks = computed(() => devices.value.filter(d => d.type === 'disk'))
watch(disks, ds => {
  for (const d of ds) if (!sharedSmart.value[d.name]) void fetchSmartInto(sharedSmart, d.name, { noWake: true })
}, { immediate: true })
const diskHealth = computed(() => disks.value.map(d => {
  const s = smartStatus(sharedSmart.value[d.name])
  return { name: d.name, health: s === 'passed' ? 'ok' : s === 'loading' ? 'unknown' : s }
}))

const rows = computed(() => poolRows({
  raids: raids.value, devices: devices.value, pvs: lvmPVs.value, vgs: lvmVGs.value,
  pools: zfs.value?.pools ?? [], datasets: zfs.value?.datasets ?? [],
}))
const facts = computed(() => storageFacts({ disks: diskHealth.value, rows: rows.value, volumes: overview.value?.volumes ?? [] }))
const sickDisks = computed(() => diskHealth.value.filter(d => d.health === 'warning' || d.health === 'failed'))
// A pool's trouble is said once, on the pool: its volumes repeat it (each
// dataset of a degraded pool, each volume of a rebuilding array).
const volumeIssues = computed(() => {
  const named = new Set([...facts.value.troubled, ...facts.value.running].map(r => r.name))
  const seen = new Set<string>()
  return (overview.value?.volumes ?? []).flatMap(v => {
    const onPool = v.stack.some(l => (l.kind === 'pool' || l.kind === 'array') && named.has(l.name))
    return v.issues
      .filter(i => !(onPool && (i.kind === 'degraded' || i.kind === 'rebuilding')))
      .filter(i => !seen.has(i.text) && !!seen.add(i.text))
      .map(i => ({ id: v.id, name: v.name, text: i.text }))
  })
})
const pct = (used: number, total: number) => (total ? Math.round((used / total) * 100) : 0)
const sized = computed(() => rows.value.filter(r => r.used != null && r.size))

const LINKS: Array<{ section: StorageSection; icon: unknown; n: () => number; label: string }> = [
  { section: 'disks', icon: HardDriveIcon, n: () => facts.value.disks, label: 'disks' },
  { section: 'pools', icon: Layers3Icon, n: () => facts.value.pools, label: 'pools' },
  { section: 'volumes', icon: DatabaseIcon, n: () => facts.value.volumes, label: 'volumes' },
  { section: 'mounts', icon: FolderTreeIcon, n: () => facts.value.mounted, label: 'mounted' },
]
const barClass = (r: PoolRow) => (r.health === 'ok' ? 'bg-base-content/70' : 'bg-warning')
</script>

<template>
  <div>
    <div class="mb-5">
      <h2 class="text-lg font-semibold text-base-content">{{ t('ui.storage.Overview.heading') }}</h2>
      <p class="mt-0.5 text-sm text-base-content/70">{{ t('ui.storage.Overview.subtitle') }}</p>
    </div>
    <p v-if="failed" role="alert" class="status-text mb-4 text-error"><span class="status-tag">[ERR]</span> {{ t('ui.storage.Overview.failed', { error: failed }) }}</p>
    <LoadingState v-if="loading && !devices.length" variant="block" />
    <template v-else>
      <div class="grid gap-3 @3xl/content:grid-cols-3">
        <Card class="block gap-0 py-0 shadow-none p-4">
          <p class="text-xs text-base-content/70">{{ t('ui.storage.Overview.capacity') }}</p>
          <p class="mt-1 font-figure text-2xl font-bold tabular-nums text-base-content">{{ fmtBytes(facts.capacity.total) }}</p>
          <p class="mt-1 text-xs text-base-content/70 tabular-nums">{{ t('ui.storage.Overview.capacityUsed', { used: fmtBytes(facts.capacity.used), pct: pct(facts.capacity.used, facts.capacity.total) }) }}</p>
          <span class="mt-3 block h-1.5 overflow-hidden rounded-full bg-base-300"><span class="block h-full rounded-full bg-base-content/70" :style="{ width: `${pct(facts.capacity.used, facts.capacity.total)}%` }" /></span>
        </Card>
        <Card class="block gap-0 py-0 shadow-none p-4">
          <p class="text-xs text-base-content/70">{{ t('ui.storage.Overview.health') }}</p>
          <p class="mt-1 font-figure text-2xl font-bold tabular-nums text-base-content">{{ facts.healthyDisks }} / {{ facts.checkedDisks }}</p>
          <p class="mt-1 text-xs text-base-content/70">{{ t('ui.storage.Overview.healthyDisks', facts.healthyDisks) }}<template v-if="facts.uncheckedDisks"> · {{ t('ui.storage.Overview.unchecked', { n: facts.uncheckedDisks }, facts.uncheckedDisks) }}</template></p>
          <ul v-if="sickDisks.length" class="mt-2 space-y-0.5 text-xs">
            <li v-for="d in sickDisks" :key="d.name" :class="d.health === 'failed' ? 'text-error' : 'text-warning'">
              <button type="button" class="hover:underline" @click="emit('navigate', { kind: 'disk', name: d.name })"><span class="font-mono">{{ d.name }}</span> · {{ t(`ui.storage.Overview.disk.${d.health}`) }}</button>
            </li>
          </ul>
        </Card>
        <Card class="block gap-0 py-0 shadow-none p-4">
          <p class="text-xs text-base-content/70">{{ t('ui.storage.Overview.running') }}</p>
          <p v-if="!facts.running.length" class="mt-2 text-sm text-base-content/70">{{ t('ui.storage.Overview.nothingRunning') }}</p>
          <button v-for="r in facts.running" :key="`${r.type}:${r.name}`" type="button" class="mt-2 block w-full text-left" @click="emit('navigate', r.location)">
            <span class="flex items-center gap-2 text-sm"><span class="font-mono font-medium">{{ r.name }}</span><TypeBadge :type="r.type" /><span class="ml-auto text-xs tabular-nums text-base-content/70">{{ r.progress }} %</span></span>
            <span class="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-base-300"><span class="block h-full rounded-full bg-info" :style="{ width: `${r.progress}%` }" /></span>
          </button>
        </Card>
      </div>

      <h3 class="mt-8 mb-3 text-sm font-semibold text-base-content">{{ t('ui.storage.Overview.layers') }}</h3>
      <Card class="block gap-0 py-0 shadow-none overflow-hidden">
        <div class="grid grid-cols-2 gap-px bg-base-300 @3xl/content:grid-cols-4">
          <button v-for="(l, i) in LINKS" :key="l.section" type="button" class="flex items-center gap-3 bg-base-100 p-4 text-left transition-colors hover:bg-base-200"
            @click="emit('navigate', l.section)">
            <component :is="l.icon" class="size-5 shrink-0 text-base-content/70" aria-hidden="true" />
            <span><span class="block font-figure text-xl font-bold tabular-nums text-base-content">{{ l.n() }}</span><span class="text-xs text-base-content/70">{{ t(`ui.storage.Overview.count.${l.label}`, l.n()) }}</span></span>
            <ChevronRightIcon v-if="i < LINKS.length - 1" class="ml-auto hidden size-4 text-base-content/40 @3xl/content:block" aria-hidden="true" />
          </button>
        </div>
      </Card>

      <template v-if="sized.length">
        <h3 class="mt-8 mb-3 text-sm font-semibold text-base-content">{{ t('ui.storage.Overview.byPool') }}</h3>
        <Card class="block gap-0 py-0 shadow-none">
          <ul class="divide-y divide-base-300">
            <li v-for="r in sized" :key="`${r.type}:${r.name}`">
              <button type="button" class="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 text-left hover:bg-base-200/50 @3xl/content:grid-cols-[12rem_1fr_auto]" @click="emit('navigate', r.location)">
                <span class="flex items-center gap-2"><span class="font-mono text-sm font-semibold">{{ r.name }}</span><TypeBadge :type="r.type" /></span>
                <span class="col-span-2 row-start-2 block h-1.5 overflow-hidden rounded-full bg-base-300 @3xl/content:col-span-1 @3xl/content:row-start-auto"><span class="block h-full rounded-full" :class="barClass(r)" :style="{ width: `${pct(r.used!, r.size)}%` }" /></span>
                <span class="text-xs tabular-nums text-base-content/70">{{ t('ui.storage.Pools.usedOf', { pct: pct(r.used!, r.size), size: fmtBytes(r.size) }) }}</span>
              </button>
            </li>
          </ul>
        </Card>
      </template>

      <h3 class="mt-8 mb-3 text-sm font-semibold text-base-content">{{ t('ui.storage.Overview.attention') }}</h3>
      <Card class="block gap-0 py-0 shadow-none">
        <ul v-if="facts.troubled.length || sickDisks.length || volumeIssues.length" class="divide-y divide-base-300 text-sm">
          <li v-for="r in facts.troubled" :key="`p:${r.type}:${r.name}`" class="flex items-center gap-3 px-4 py-3">
            <TriangleAlertIcon class="size-4 shrink-0" :class="r.health === 'failed' ? 'text-error' : 'text-warning'" aria-hidden="true" />
            <span class="min-w-0 flex-1">{{ t(`ui.storage.Overview.pool.${r.health}`, { name: r.name }) }}</span>
            <button type="button" class="btn btn-ghost btn-xs" @click="emit('navigate', r.location)">{{ t('ui.storage.Overview.see') }}</button>
          </li>
          <li v-for="d in sickDisks" :key="`d:${d.name}`" class="flex items-center gap-3 px-4 py-3">
            <TriangleAlertIcon class="size-4 shrink-0" :class="d.health === 'failed' ? 'text-error' : 'text-warning'" aria-hidden="true" />
            <span class="min-w-0 flex-1"><span class="font-mono">{{ d.name }}</span> · {{ t(`ui.storage.Overview.disk.${d.health}`) }}</span>
            <button type="button" class="btn btn-ghost btn-xs" @click="emit('navigate', { kind: 'disk', name: d.name })">{{ t('ui.storage.Overview.see') }}</button>
          </li>
          <li v-for="(v, i) in volumeIssues" :key="`v:${v.id}:${i}`" class="flex items-center gap-3 px-4 py-3">
            <TriangleAlertIcon class="size-4 shrink-0 text-warning" aria-hidden="true" />
            <span class="min-w-0 flex-1"><span class="font-medium">{{ v.name }}</span> · {{ v.text }}</span>
            <button type="button" class="btn btn-ghost btn-xs" @click="emit('navigate', { kind: 'volume', id: v.id })">{{ t('ui.storage.Overview.see') }}</button>
          </li>
        </ul>
        <p v-else-if="!failed" class="flex items-center gap-2 px-4 py-3 text-sm text-success"><CircleCheckIcon class="size-4" aria-hidden="true" />{{ t('ui.storage.Overview.allWell') }}</p>
      </Card>
    </template>
  </div>
</template>
