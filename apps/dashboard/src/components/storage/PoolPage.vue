<script setup lang="ts">
import { growOptions } from './grow-model'
import GrowPoolDialog from './GrowPoolDialog.vue'
import ReplaceDiskDialog from './ReplaceDiskDialog.vue'
import { unguardedDatasets } from './pool-summary'
import DatasetDialog from './DatasetDialog.vue'
import { useI18n } from 'vue-i18n'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import LoadingState from '../ui/LoadingState.vue'
import PoolCard from './PoolCard.vue'
import { useToast } from '../../lib/toast'
import { applyPlanned } from '../../lib/plan'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { fmtBytes } from './store'
import { isWatched, loadZfs, zfs } from './zfs-data'

// One pool: its card, its datasets, and whether HSI watches it.
const props = defineProps<{ name: string }>()
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation] }>()
const { t } = useI18n()
const toast = useToast()

onMounted(() => { void loadZfs() })
const pool = computed(() => zfs.value?.pools.find(p => p.name === props.name) ?? null)
const datasets = computed(() => (zfs.value?.datasets ?? []).filter(d => d.pool === props.name))
const watched = computed(() => !!(zfs.value && pool.value && isWatched(zfs.value, pool.value)))
watch(() => props.name, () => { void loadZfs() })
const datasetOpen = ref(false)
const replacing = ref<string | null>(null)
// A scrub or a resilver running: the page follows it every 5 s.
const busy = computed(() => pool.value?.scan.state === 'running' || pool.value?.expand?.state === 'running')
// How the pool can grow (lot 5).
const grow = computed(() => (pool.value ? growOptions(pool.value, zfs.value?.version ?? '') : null))
const growing = ref<{ mode: 'add' | 'attach'; vdev?: string } | null>(null)

async function expandPool() {
  try {
    await applyPlanned('zfs.pool.expand', { pool: props.name }, { title: t('ui.storage.ZfsGrow.expandTitle', { name: props.name }), actionLabel: t('ui.storage.ZfsGrow.expand') })
    await loadZfs()
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
const hasErrors = computed(() => {
  const walk = (vs: Array<{ read: number; write: number; checksum: number; children: any[] }>): boolean =>
    vs.some(v => v.read + v.write + v.checksum > 0 || walk(v.children))
  // The disks' counters only: zpool clear resets them, not the last scan's summary.
  return !!pool.value && walk(pool.value.vdevs)
})
let timer: ReturnType<typeof setInterval> | null = null
watch(busy, b => {
  if (b && !timer) timer = setInterval(() => { void loadZfs() }, 5000)
  if (!b && timer) { clearInterval(timer); timer = null }
}, { immediate: true })
onUnmounted(() => { if (timer) clearInterval(timer) })

async function repair(op: 'zfs.scrub' | 'zfs.clear', extra: Record<string, unknown>) {
  const key = op === 'zfs.clear' ? 'clear' : extra.stop ? 'stopScrub' : 'scrubNow'
  try {
    await applyPlanned(op, { pool: props.name, ...extra }, { title: t(`ui.storage.ZfsRepair.${key}Title`, { name: props.name }), actionLabel: t(`ui.storage.ZfsRepair.${key}`) })
    await loadZfs()
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
// Datasets made by hand since the pool was watched: Watch again guards them too.
const unguarded = computed(() => (zfs.value ? unguardedDatasets(props.name, zfs.value.datasets, zfs.value.watched) : []))

async function destroyPool() {
  try {
    await applyPlanned('zfs.pool.destroy', { name: props.name }, {
      title: t('ui.storage.ZfsCreate.deleteTitle', { name: props.name }), actionLabel: t('ui.storage.ZfsCreate.deletePool'),
      danger: true, confirmText: props.name, notice: t('ui.storage.ZfsCreate.deleteNotice'),
    })
    toast.success(t('ui.storage.ZfsCreate.deleted', { name: props.name }))
    await loadZfs()
    emit('navigate', 'pools')
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}

async function run(op: 'zfs.watch' | 'zfs.unwatch') {
  const watching = op === 'zfs.watch'
  try {
    await applyPlanned(op, { name: props.name }, {
      title: t(watching ? 'ui.storage.Zfs.watchTitle' : 'ui.storage.Zfs.unwatchTitle', { name: props.name }),
      actionLabel: t(watching ? 'ui.storage.Zfs.watch' : 'ui.storage.Zfs.unwatch'),
      notice: t(watching ? 'ui.storage.Zfs.watchHint' : 'ui.storage.Zfs.unwatchHint'),
    })
    toast.success(t(watching ? 'ui.storage.Zfs.watchedToast' : 'ui.storage.Zfs.unwatchedToast', { name: props.name }))
    await loadZfs()
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
</script>

<template>
  <div>
    <LoadingState v-if="!zfs" variant="block" />
    <Card v-else-if="!pool" class="block gap-0 py-0 shadow-none px-4 py-8 text-center text-sm text-base-content/80">
      {{ t('ui.storage.Zfs.gone') }}
      <Button variant="link" class="ml-1 h-auto p-0 text-base-content underline" @click="emit('navigate', 'pools')">{{ t('ui.storage.Zfs.back') }}</Button>
    </Card>
    <template v-else>
      <PoolCard :pool="pool" :watched="watched" compact replaceable @open="() => {}" @watch="run('zfs.watch')" @replace="leaf => replacing = leaf" />
      <p class="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <Button v-if="pool.scan.state !== 'running'" variant="outline" size="xs" @click="repair('zfs.scrub', {})">{{ t('ui.storage.ZfsRepair.scrubNow') }}</Button>
        <Button v-else-if="pool.scan.kind === 'scrub'" variant="outline" size="xs" @click="repair('zfs.scrub', { stop: true })">{{ t('ui.storage.ZfsRepair.stopScrub') }}</Button>
        <Button v-if="hasErrors" variant="outline" size="xs" @click="repair('zfs.clear', {})">{{ t('ui.storage.ZfsRepair.clear') }}</Button>
        <span v-if="busy" class="text-base-content/70">{{ t('ui.storage.ZfsRepair.refreshing') }}</span>
      </p>
      <section v-if="grow" class="mt-4">
        <h3 class="text-sm font-semibold text-base-content">{{ t('ui.storage.ZfsGrow.heading') }}</h3>
        <p v-if="pool.expand?.state === 'running'" class="mt-1 text-xs text-base-content/80 tabular-nums">{{ t('ui.storage.ZfsGrow.expanding', { vdev: pool.expand.vdev, pct: Math.round(pool.expand.pct ?? 0) }) }}</p>
        <p class="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <Button v-if="grow.layout" variant="outline" size="xs" @click="growing = { mode: 'add' }">{{ t('ui.storage.ZfsGrow.addButton', { n: grow.layout === 'stripe' ? 1 : grow.width }, grow.layout === 'stripe' ? 1 : grow.width) }}</Button>
          <Button v-for="a in grow.attach" :key="a.vdev" variant="outline" size="xs" @click="growing = { mode: 'attach', vdev: a.vdev }">{{ t('ui.storage.ZfsGrow.attachButton', { vdev: a.vdev }) }}</Button>
          <Button v-if="grow.expand" variant="outline" size="xs" @click="expandPool">{{ t('ui.storage.ZfsGrow.expandButton', { size: fmtBytes(pool.expandSize ?? 0) }) }}</Button>
          <span v-if="!grow.layout" class="text-base-content/70">{{ t('ui.storage.ZfsGrow.mixed') }}</span>
        </p>
      </section>
      <GrowPoolDialog v-if="growing" :pool="pool.name" :mode="growing.mode" :vdev="growing.vdev" :layout="grow?.layout ?? undefined" :width="grow?.width" @close="growing = null" @done="growing = null; void loadZfs()" />
      <ReplaceDiskDialog v-if="replacing" :pool="pool.name" :leaf="replacing" @close="replacing = null" @done="replacing = null; void loadZfs()" />
      <p class="mt-3 flex flex-wrap items-center gap-3 text-xs text-base-content/70">
        <span>{{ watched ? t('ui.storage.Zfs.watchedLine') : t('ui.storage.Zfs.notWatchedLine') }}</span>
        <Button v-if="watched" variant="outline" size="xs" @click="run('zfs.unwatch')">{{ t('ui.storage.Zfs.unwatch') }}</Button>
        <Button v-if="watched && unguarded.length" variant="outline" size="xs" @click="run('zfs.watch')">{{ t('ui.storage.Zfs.guardNew', { n: unguarded.length }, unguarded.length) }}</Button>
        <Button variant="outline" size="xs" class="ml-auto" @click="datasetOpen = true">{{ t('ui.storage.ZfsDataset.newHeading') }}</Button>
        <Button variant="outline" size="xs" class="text-error" @click="destroyPool">{{ t('ui.storage.ZfsCreate.deletePool') }}</Button>
      </p>
      <DatasetDialog v-if="datasetOpen" mode="create" :parents="datasets.filter(d => !d.name.includes('@')).map(d => d.name)"
        @close="datasetOpen = false" @done="datasetOpen = false; void loadZfs()" />
      <h3 class="mt-6 mb-2 text-sm font-semibold text-base-content">{{ t('ui.storage.Zfs.datasets') }}</h3>
      <Card class="block gap-0 py-0 shadow-none overflow-hidden">
        <ul class="divide-y divide-base-300">
          <li v-for="d in datasets" :key="d.name" class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
            <span class="min-w-0 flex-1 truncate font-mono">{{ d.name }}</span>
            <span class="font-mono text-xs text-base-content/70">{{ d.mountPoint }}</span>
            <span class="tabular-nums text-xs text-base-content/80">{{ fmtBytes(d.used) }}</span>
          </li>
        </ul>
      </Card>
    </template>
  </div>
</template>
