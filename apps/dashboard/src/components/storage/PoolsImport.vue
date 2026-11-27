<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { onMounted, ref } from 'vue'
import { Card } from '@/components/ui/card'
import { trpc } from '../../lib/trpc'
import ImportFound from './ImportFound.vue'
import ZfsImportSection from './ZfsImportSection.vue'
import { useStorageData } from './store'
import { zfs } from './zfs-data'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'

// Pools found on the disks and not in use yet, of every type: mdadm arrays
// and LVM groups brought from another machine, and ZFS pools.
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation] }>()
const { t } = useI18n()
const { refresh } = useStorageData()
// Without ZFS, and with no array or group found, the page says so.
const nothing = ref(false)
onMounted(async () => {
  try {
    const s = await trpc.storage.importScan.query()
    nothing.value = !s.arrays.length && !s.vgs.length
  } catch { nothing.value = false }
})
</script>

<template>
  <div>
    <div class="mb-4">
      <h2 class="text-lg font-semibold text-base-content">{{ t('ui.storage.Pools.importHeading') }}</h2>
      <p class="mt-0.5 text-sm text-base-content/70">{{ t('ui.storage.Pools.importSubtitle') }}</p>
    </div>
    <ImportFound kind="raid" @imported="refresh" />
    <ImportFound kind="lvm" @imported="refresh" />
    <ZfsImportSection v-if="zfs?.available" embedded @navigate="l => emit('navigate', l)" />
    <Card v-else-if="nothing" class="block gap-0 py-0 shadow-none px-4 py-8 text-center text-sm text-base-content/70">{{ t('ui.storage.Pools.nothingToImport') }}</Card>
  </div>
</template>
