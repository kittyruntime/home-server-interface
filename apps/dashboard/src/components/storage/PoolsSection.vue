<script setup lang="ts">
import { trpc } from '../../lib/trpc'
import CreatePoolDialog from './CreatePoolDialog.vue'
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { Card } from '@/components/ui/card'
import LoadingState from '../ui/LoadingState.vue'
import StorageIntro from './StorageIntro.vue'
import PoolCard from './PoolCard.vue'
import TermHelp from './TermHelp.vue'
import { useToast } from '../../lib/toast'
import { applyPlanned } from '../../lib/plan'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { isWatched, loadZfs, zfs, zfsError, type ZfsPool } from './zfs-data'
import { missingWatched } from './pool-summary'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'

// The ZFS pools imported on this server.
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation] }>()
const { t } = useI18n()
const toast = useToast()
const loading = ref(!zfs.value)
onMounted(async () => { await loadZfs(); loading.value = false })

const createOpen = ref(false)
const freeDisks = ref<Array<{ name: string; size: number; model: string; serial?: string }>>([])
async function openCreate() {
  try { freeDisks.value = (await trpc.storage.volumes.overview.query()).freeDisks } catch { freeDisks.value = [] }
  createOpen.value = true
}

const missing = computed(() => (zfs.value ? missingWatched(zfs.value.watched, zfs.value.pools) : []))
const bootOff = computed(() => !!zfs.value?.available && !!zfs.value.bootUnits && (!zfs.value.bootUnits.importCache || !zfs.value.bootUnits.mount))

async function unwatch(name: string) {
  try {
    await applyPlanned('zfs.unwatch', { name }, { title: t('ui.storage.Zfs.unwatchTitle', { name }), actionLabel: t('ui.storage.Zfs.unwatch'), notice: t('ui.storage.Zfs.unwatchMissingHint') })
    toast.success(t('ui.storage.Zfs.unwatchedToast', { name }))
    await loadZfs()
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}

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
    <div class="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div class="min-w-0 flex-1 basis-56">
        <h2 class="flex items-center gap-1.5 text-lg font-semibold text-base-content">{{ t('ui.storage.Zfs.pools') }}<TermHelp term="vdev" /></h2>
        <p class="mt-0.5 text-sm text-base-content/70">{{ t('ui.storage.Zfs.poolsSubtitle') }}</p>
      </div>
      <Button v-if="zfs?.available" size="sm" class="shrink-0" @click="openCreate">{{ t('ui.storage.ZfsCreate.heading') }}</Button>
    </div>
    <CreatePoolDialog v-if="createOpen" :free-disks="freeDisks" :taken="zfs?.pools.map(p => p.name) ?? []"
      @close="createOpen = false" @created="name => { createOpen = false; void loadZfs(); emit('navigate', { kind: 'pool', name }) }" />
    <StorageIntro tab="zfs" />
    <LoadingState v-if="loading" variant="block" />
    <p v-else-if="zfsError && !zfs" role="alert" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ zfsError }}</p>
    <template v-else-if="zfs">
      <Alert v-if="!zfs.available" variant="destructive" class="mb-4 block" role="alert">{{ t('ui.storage.Zfs.unavailable') }}</Alert>
      <Alert v-if="bootOff" variant="warning" class="mb-4 block" role="note">{{ t('ui.storage.Zfs.bootUnitsOff') }} <code class="font-mono">systemctl enable zfs-import-cache.service zfs-mount.service</code></Alert>
      <Card v-for="w in missing" :key="w.guid" class="mb-4 block gap-0 py-0 shadow-none border-error/40 p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold">{{ w.name }}</span>
          <span class="badge badge-error badge-sm">{{ t('ui.storage.Zfs.missing') }}</span>
          <Button variant="outline" size="xs" class="ml-auto" @click="unwatch(w.name)">{{ t('ui.storage.Zfs.unwatch') }}</Button>
        </div>
        <p class="mt-2 text-xs text-base-content/80">{{ t('ui.storage.Zfs.missingLine', { n: w.datasets.length }, w.datasets.length) }}</p>
      </Card>
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
