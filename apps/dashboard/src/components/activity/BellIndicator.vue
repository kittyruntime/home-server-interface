<script setup lang="ts">
import { computed } from 'vue'
import { useActivity } from '../../lib/activity'

/* Shows on the bell that something runs, without opening the panel: a ring
   that fills with this browser's uploads, or a dot for work on the NAS. Sits
   in a relative parent, around its icon. */
const { items, uploadPercent } = useActivity()
const serverRunning = computed(() => items.value.some(i => i.kind !== 'upload' && (i.status === 'running' || i.status === 'queued')))
</script>

<template>
  <span v-if="uploadPercent !== null" class="radial-progress pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-primary"
    :style="{ '--value': uploadPercent, '--size': '2rem', '--thickness': '2px' }" role="progressbar" :aria-valuenow="uploadPercent" aria-valuemin="0" aria-valuemax="100" />
  <span v-else-if="serverRunning" class="pointer-events-none absolute bottom-1.5 right-1.5 size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden="true" />
</template>
