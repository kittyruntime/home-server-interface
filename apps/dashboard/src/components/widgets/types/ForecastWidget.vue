<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { TrendingUpIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import { ROWS, TEXT, type Tone } from '../kit/tone'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { formatBytes } from '../../../lib/file-details'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const forecast = useSource('forecast', () => trpc.dashboard.forecast.query(), 900_000)
const volumes = useSource('volumes', () => trpc.storage.volumes.overview.query(), 60_000)
reportSources(forecast, volumes)

function horizon(days: number): { text: string; tone: Tone } {
  if (days < 30) return { text: t('widgets.forecast.days', { n: Math.max(1, Math.round(days)) }, Math.max(1, Math.round(days))), tone: days < 14 ? 'bad' : 'warn' }
  if (days < 730) { const n = Math.round(days / 30); return { text: t('widgets.forecast.months', { n }, n), tone: days < 90 ? 'warn' : 'ok' } }
  return { text: t('widgets.forecast.years'), tone: 'ok' }
}

const rows = computed(() => (volumes.data.value?.volumes ?? []).filter(v => v.space).slice(0, ROWS[props.size]).map(v => {
  const f = forecast.data.value?.[v.id]
  return { id: v.id, name: v.name, f, h: f?.daysLeft != null ? horizon(f.daysLeft) : null }
}))
</script>

<template>
  <Empty v-if="volumes.data.value && !rows.length" :icon="TrendingUpIcon" :text="t('widgets.volumes.none')" />
  <ul v-else class="flex flex-1 flex-col divide-y divide-base-300">
    <li v-for="r in rows" :key="r.id" class="flex flex-col gap-0.5 py-2 first:pt-0">
      <div class="flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate text-sm font-medium text-base-content">{{ r.name }}</span>
        <span v-if="r.h" :class="['shrink-0 text-xs font-medium', r.h.tone === 'ok' ? 'text-base-content' : TEXT[r.h.tone]]">{{ r.h.text }}</span>
        <span v-else-if="r.f" class="shrink-0 text-xs text-base-content/70">{{ t('widgets.forecast.stable') }}</span>
        <span v-else class="shrink-0 text-xs text-base-content/60">{{ t('widgets.forecast.learning') }}</span>
      </div>
      <p v-if="r.f && r.f.perDay > 1_048_576" class="text-xs tabular-nums text-base-content/60">{{ t('widgets.forecast.perDay', { size: formatBytes(r.f.perDay) }) }}</p>
      <p v-else-if="!r.f" class="text-xs text-base-content/60">{{ t('widgets.forecast.learningHint') }}</p>
    </li>
  </ul>
</template>
