<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DatabaseIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import Meter from '../kit/Meter.vue'
import { ROWS, TEXT, type Tone } from '../kit/tone'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { formatBytes } from '../../../lib/file-details'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const src = useSource('volumes', () => trpc.storage.volumes.overview.query(), 60_000)
reportSources(src)

type Volume = NonNullable<typeof src.data.value>['volumes'][number]
function state(v: Volume): { key: string; tone: Tone } {
  if (v.state === 'missing') return { key: 'missing', tone: 'bad' }
  if (v.issues.some(i => i.kind === 'degraded')) return { key: 'degraded', tone: 'bad' }
  if (v.issues.some(i => i.kind === 'rebuilding')) return { key: 'rebuilding', tone: 'warn' }
  if (v.state === 'not-mounted') return { key: 'notMounted', tone: 'warn' }
  if (v.issues.some(i => i.kind === 'nearly-full')) return { key: 'nearlyFull', tone: 'warn' }
  return { key: 'healthy', tone: 'ok' }
}
const pct = (v: Volume) => v.space && v.space.total > 0 ? (v.space.used / v.space.total) * 100 : 0
const volumes = computed(() => (src.data.value?.volumes ?? []).slice(0, ROWS[props.size]))
</script>

<template>
  <Empty v-if="src.data.value && !src.data.value.volumes.length" :icon="DatabaseIcon" :text="t('widgets.volumes.none')" />
  <ul v-else class="flex flex-1 flex-col gap-3">
    <li v-for="v in volumes" :key="v.id" class="flex flex-col gap-1.5">
      <div class="flex items-baseline gap-2 text-xs">
        <span class="min-w-0 truncate text-sm font-medium text-base-content">{{ v.name }}</span>
        <span :class="['shrink-0', TEXT[state(v).tone]]">{{ t(`widgets.volumes.state.${state(v).key}`) }}</span>
        <span v-if="v.space" class="ml-auto shrink-0 tabular-nums text-base-content/70">{{ t('widgets.freeOf', { free: formatBytes(v.space.free), total: formatBytes(v.space.total) }) }}</span>
      </div>
      <Meter v-if="v.space" :value="pct(v)" :warn="80" :bad="90" :label="v.name" />
    </li>
  </ul>
</template>
