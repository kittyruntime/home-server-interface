<script setup lang="ts">
import { useI18n } from 'vue-i18n'
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
  </div>
</template>
