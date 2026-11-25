<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, watch } from 'vue'
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
      <PoolCard :pool="pool" :watched="watched" compact @open="() => {}" @watch="run('zfs.watch')" />
      <p class="mt-3 flex flex-wrap items-center gap-3 text-xs text-base-content/70">
        <span>{{ watched ? t('ui.storage.Zfs.watchedLine') : t('ui.storage.Zfs.notWatchedLine') }}</span>
        <Button v-if="watched" variant="outline" size="xs" @click="run('zfs.unwatch')">{{ t('ui.storage.Zfs.unwatch') }}</Button>
      </p>
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
