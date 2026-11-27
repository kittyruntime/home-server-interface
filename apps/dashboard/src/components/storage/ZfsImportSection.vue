<script setup lang="ts">
import TypeBadge from './TypeBadge.vue'
import { useI18n } from 'vue-i18n'
import { onMounted, ref } from 'vue'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import LoadingState from '../ui/LoadingState.vue'
import PoolTopology from './PoolTopology.vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import { applyPlanned } from '../../lib/plan'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { loadZfs } from './zfs-data'

// Pools found on the disks but not imported (disks from another machine, or
// after a reinstall). Importing changes no data and mounts only in the data
// folders; the pool is then watched like any HSI volume.
// `embedded`: inside Pools > Import, under its own heading: a sub-heading here.
defineProps<{ embedded?: boolean }>()
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation] }>()
const { t } = useI18n()
const toast = useToast()
type Scan = Awaited<ReturnType<typeof trpc.storage.zfs.importScan.query>>
const scan = ref<Scan | null>(null)
const error = ref<string | null>(null)
const lowMemory = ref(false)
const busy = ref<string | null>(null)

async function load() {
  try {
    scan.value = await trpc.storage.zfs.importScan.query()
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  }
}
onMounted(async () => {
  await load()
  try { lowMemory.value = (await trpc.storage.zfs.memory.query()).low } catch { /* no warning */ }
})

async function importPool(p: Scan['pools'][number]) {
  busy.value = p.guid
  try {
    await applyPlanned('zfs.import', { guid: p.guid, name: p.name, force: p.otherHost }, {
      title: t('ui.storage.Zfs.importTitle', { name: p.name }),
      actionLabel: t(p.otherHost ? 'ui.storage.Zfs.importForce' : 'ui.storage.Zfs.importBtn'),
      danger: p.otherHost,
      notice: [p.otherHost ? t('ui.storage.Zfs.otherHostWarning') : '', lowMemory.value ? t('ui.storage.Zfs.lowMemory') : t('ui.storage.Zfs.importNotice')].filter(Boolean).join(' '),
    })
    toast.success(t('ui.storage.Zfs.imported', { name: p.name }))
    await Promise.all([load(), loadZfs()])
    emit('navigate', { kind: 'pool', name: p.name })
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div>
    <div class="mb-4">
      <h3 v-if="embedded" class="flex items-center gap-2 text-sm font-semibold text-base-content">{{ t('ui.storage.Zfs.import') }}<TypeBadge type="zfs" /></h3>
      <h2 v-else class="text-lg font-semibold text-base-content">{{ t('ui.storage.Zfs.import') }}</h2>
      <p class="mt-0.5 text-sm text-base-content/70">{{ t('ui.storage.Zfs.importSubtitle') }}</p>
    </div>
    <Alert v-if="lowMemory" variant="warning" class="mb-4 block" role="note">{{ t('ui.storage.Zfs.lowMemory') }}</Alert>
    <LoadingState v-if="!scan && !error" variant="block" />
    <p v-else-if="error" role="alert" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <Card v-else-if="scan && !scan.pools.length" class="block gap-0 py-0 shadow-none px-4 py-8 text-center text-sm text-base-content/70">{{ t('ui.storage.Zfs.noImportable') }}</Card>
    <div v-else-if="scan" class="space-y-4">
      <Card v-for="p in scan.pools" :key="p.guid" class="block gap-0 py-0 shadow-none p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold">{{ p.name }}</span>
          <span class="badge badge-sm" :class="p.state === 'ONLINE' ? 'badge-success badge-soft' : 'badge-warning'">{{ t(`ui.storage.Zfs.state.${p.state}`, p.state) }}</span>
          <span class="font-mono text-xs text-base-content/70">{{ p.guid }}</span>
          <Button size="sm" class="ml-auto" :disabled="p.state !== 'ONLINE' && p.state !== 'DEGRADED' || busy !== null" @click="importPool(p)">
            {{ busy === p.guid ? t('ui.storage.Zfs.importing') : t('ui.storage.Zfs.importBtn') }}
          </Button>
        </div>
        <p v-if="p.otherHost" class="mt-2 text-xs text-warning">{{ t('ui.storage.Zfs.otherHost') }}</p>
        <p v-else-if="p.status && p.state !== 'ONLINE' && p.state !== 'DEGRADED'" class="mt-2 text-xs text-warning">{{ t('ui.storage.Zfs.cannotImport', { status: p.status }) }}</p>
        <p v-else-if="p.status" class="mt-2 text-xs text-base-content/70">{{ p.status }}</p>
        <div class="mt-3"><PoolTopology :pool="{ name: p.name, state: p.state, vdevs: p.vdevs }" /></div>
      </Card>
    </div>
  </div>
</template>
