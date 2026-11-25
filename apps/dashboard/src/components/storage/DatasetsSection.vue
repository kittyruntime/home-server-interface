<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import LoadingState from '../ui/LoadingState.vue'
import { trpc } from '../../lib/trpc'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { fmtBytes } from './store'
import { loadZfs, zfs, type ZfsDataset } from './zfs-data'

// Every filesystem dataset of the imported pools. Those ZFS mounts on a folder
// of their own are volumes; the others say why they are not.
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation] }>()
const { t } = useI18n()
type Overview = Awaited<ReturnType<typeof trpc.storage.volumes.overview.query>>
const overview = ref<Overview | null>(null)
const loading = ref(true)
onMounted(async () => {
  await Promise.all([loadZfs(), trpc.storage.volumes.overview.query().then(o => { overview.value = o }).catch(() => {})])
  loading.value = false
})

// A dataset's volume id is zfs:<pool guid>:<dataset>, as the server builds it.
const volumeOf = (d: ZfsDataset) => {
  const guid = zfs.value?.pools.find(p => p.name === d.pool)?.guid
  return guid ? overview.value?.volumes.find(v => v.id === `zfs:${guid}:${d.name}`) : undefined
}
const usedBy = (d: ZfsDataset) => {
  const v = volumeOf(d)
  if (!v) return ''
  return [...v.usedBy.places.map(p => p.name), ...v.usedBy.apps].join(', ')
}
const rows = computed(() => [...(zfs.value?.datasets ?? [])].sort((a, b) => a.name.localeCompare(b.name)))
const isVolume = (d: ZfsDataset) => d.mountPoint.startsWith('/') && (d.canMount ?? 'on') === 'on'
</script>

<template>
  <div>
    <div class="mb-4">
      <h2 class="text-lg font-semibold text-base-content">{{ t('ui.storage.Zfs.datasets') }}</h2>
      <p class="mt-0.5 text-sm text-base-content/70">{{ t('ui.storage.Zfs.datasetsSubtitle') }}</p>
    </div>
    <LoadingState v-if="loading" variant="block" />
    <Card v-else-if="!rows.length" class="block gap-0 py-0 shadow-none px-4 py-8 text-center text-sm text-base-content/70">{{ t('ui.storage.Zfs.noDatasets') }}</Card>
    <Card v-else class="block gap-0 py-0 shadow-none overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr>
            <th>{{ t('ui.storage.Zfs.colName') }}</th>
            <th>{{ t('ui.storage.Zfs.colMount') }}</th>
            <th class="text-right">{{ t('ui.storage.Zfs.colUsed') }}</th>
            <th class="text-right">{{ t('ui.storage.Zfs.colQuota') }}</th>
            <th class="text-right">{{ t('ui.storage.Zfs.colRatio') }}</th>
            <th>{{ t('ui.storage.Zfs.colUsedBy') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in rows" :key="d.name">
            <td class="font-mono">
              <Button v-if="volumeOf(d)" variant="link" class="h-auto p-0 font-mono text-base-content" @click="emit('navigate', { kind: 'volume', id: volumeOf(d)!.id })">{{ d.name }}</Button>
              <span v-else>{{ d.name }}</span>
            </td>
            <td class="font-mono text-xs">
              <span v-if="isVolume(d)" :class="d.mounted ? '' : 'text-warning'">{{ d.mountPoint }}<template v-if="!d.mounted"> · {{ t('ui.storage.Zfs.notMounted') }}</template></span>
              <span v-else-if="d.mountPoint.startsWith('/')" class="text-base-content/70">{{ d.mountPoint }} · {{ t('ui.storage.Zfs.container', { cm: d.canMount }) }}</span>
              <span v-else class="text-base-content/70">{{ t('ui.storage.Zfs.notVolume', { mp: d.mountPoint }) }}</span>
            </td>
            <td class="text-right tabular-nums">{{ fmtBytes(d.used) }}</td>
            <td class="text-right tabular-nums">{{ d.quota ? fmtBytes(d.quota) : '-' }}</td>
            <td class="text-right tabular-nums">{{ d.ratio.toFixed(2) }}×</td>
            <td class="max-w-48 truncate text-xs text-base-content/80">{{ usedBy(d) || '-' }}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  </div>
</template>
