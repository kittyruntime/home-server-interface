<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AppWindowIcon, ExternalLinkIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import { DOT, ROWS, type Tone } from '../kit/tone'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const src = useSource('apps', () => trpc.container.app.list.query(), 30_000)
reportSources(src)

const TONE: Record<string, Tone> = { running: 'ok', stopped: 'neutral', error: 'bad' }
const apps = computed(() => [...(src.data.value ?? [])].sort((a, b) => (a.status === 'error' ? 0 : 1) - (b.status === 'error' ? 0 : 1) || a.name.localeCompare(b.name)))
const counts = computed(() => ({
  running: apps.value.filter(a => a.status === 'running').length,
  stopped: apps.value.filter(a => a.status === 'stopped').length,
  error: apps.value.filter(a => a.status === 'error').length,
  updates: apps.value.filter(a => a.catalogUpdate).length,
}))
// The app's web page: its first published port on this server's address.
function webUrl(a: (typeof apps.value)[number]): string | null {
  const port = a.app?.ports?.[0]?.hostPort
  return port ? `http://${location.hostname}:${port}` : null
}
</script>

<template>
  <Empty v-if="src.data.value && !apps.length" :icon="AppWindowIcon" :text="t('widgets.apps.none')" />
  <div v-else-if="src.data.value" class="flex flex-1 flex-col gap-2">
    <p class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <span class="text-base-content/80"><span class="font-figure text-2xl font-bold tabular-nums text-base-content">{{ counts.running }}</span> {{ t('widgets.apps.running', counts.running) }}</span>
      <span v-if="counts.error" class="self-end text-error">{{ t('widgets.apps.errors', { n: counts.error }, counts.error) }}</span>
      <span v-if="counts.stopped" class="self-end text-base-content/60">{{ t('widgets.apps.stopped', { n: counts.stopped }, counts.stopped) }}</span>
      <span v-if="counts.updates" class="self-end text-warning">{{ t('widgets.apps.updates', { n: counts.updates }, counts.updates) }}</span>
    </p>
    <ul v-if="props.size !== 's'" class="flex flex-col divide-y divide-base-300">
      <li v-for="a in apps.slice(0, ROWS[props.size])" :key="a.name" class="flex items-center gap-2 py-1.5 text-xs">
        <span :class="['size-2 shrink-0 rounded-full', DOT[TONE[a.status] ?? 'neutral']]" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate font-mono text-base-content">{{ a.name }}</span>
        <span v-if="a.catalogUpdate" class="text-warning">{{ t('widgets.apps.update') }}</span>
        <span class="text-base-content/60">{{ t(`widgets.apps.status.${TONE[a.status] ? a.status : 'other'}`) }}</span>
        <a
          v-if="webUrl(a) && a.status === 'running'" :href="webUrl(a)!" target="_blank" rel="noopener noreferrer"
          class="-my-1 flex size-7 items-center justify-center rounded-field text-base-content/60 hover:bg-base-200 hover:text-base-content"
          :aria-label="t('widgets.apps.openApp', { name: a.name })"
        ><ExternalLinkIcon class="size-3.5" aria-hidden="true" /></a>
      </li>
    </ul>
  </div>
</template>
