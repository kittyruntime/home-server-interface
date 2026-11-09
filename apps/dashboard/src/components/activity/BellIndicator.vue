<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useActivity } from '../../lib/activity'

/* Shows on the bell that something runs, without opening the panel: a bar
   that fills with this browser's uploads, or a dot for work on the NAS. Sits
   in a relative parent, under its icon. */
const { t } = useI18n()
const { items, uploadPercent } = useActivity()
const serverRunning = computed(() => items.value.some(i => i.kind !== 'upload' && (i.status === 'running' || i.status === 'queued')))
</script>

<template>
  <!-- A bar under the bell rather than a ring around it: the unread badge sits
       on the ring's first quarter and would hide the progress. -->
  <span v-if="uploadPercent !== null" class="pointer-events-none absolute bottom-1 left-1/2 h-1 w-6 -translate-x-1/2 overflow-hidden rounded-full bg-primary/20"
    role="progressbar" :aria-label="t('activity.uploading')" :aria-valuenow="uploadPercent" aria-valuemin="0" aria-valuemax="100">
    <span class="block h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" :style="{ width: `${Math.max(uploadPercent, 4)}%` }" />
  </span>
  <span v-else-if="serverRunning" class="pointer-events-none absolute bottom-1.5 right-1.5 size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden="true" />
</template>
