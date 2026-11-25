<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { onMounted, ref } from 'vue'
import { Card } from '@/components/ui/card'
import LoadingState from '../ui/LoadingState.vue'
import StorageIntro from './StorageIntro.vue'
import PoolCard from './PoolCard.vue'
import TermHelp from './TermHelp.vue'
import { useToast } from '../../lib/toast'
import { applyPlanned } from '../../lib/plan'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { isWatched, loadZfs, zfs, zfsError, type ZfsPool } from './zfs-data'

// The ZFS pools imported on this server.
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation] }>()
const { t } = useI18n()
const toast = useToast()
const loading = ref(!zfs.value)
onMounted(async () => { await loadZfs(); loading.value = false })

async function watch(p: ZfsPool) {
  try {
    await applyPlanned('zfs.watch', { name: p.name }, { title: t('ui.storage.Zfs.watchTitle', { name: p.name }), actionLabel: t('ui.storage.Zfs.watch'), notice: t('ui.storage.Zfs.watchHint') })
    toast.success(t('ui.storage.Zfs.watchedToast', { name: p.name }))
    await loadZfs()
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
</script>

<template>
  <div>
    <div class="mb-4">
      <h2 class="flex items-center gap-1.5 text-lg font-semibold text-base-content">{{ t('ui.storage.Zfs.pools') }}<TermHelp term="vdev" /></h2>
      <p class="mt-0.5 text-sm text-base-content/70">{{ t('ui.storage.Zfs.poolsSubtitle') }}</p>
    </div>
    <StorageIntro tab="zfs" />
    <LoadingState v-if="loading" variant="block" />
    <p v-else-if="zfsError && !zfs" role="alert" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ zfsError }}</p>
    <template v-else-if="zfs">
      <Card v-if="!zfs.pools.length" class="block gap-0 py-0 shadow-none px-4 py-8 text-center text-sm text-base-content/70">
        {{ t('ui.storage.Zfs.noPools') }}
      </Card>
      <div v-else class="space-y-4">
        <PoolCard v-for="p in zfs.pools" :key="p.guid" :pool="p" :watched="isWatched(zfs, p)"
          @open="emit('navigate', { kind: 'pool', name: p.name })" @watch="watch(p)" />
      </div>
    </template>
  </div>
</template>
