<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlertIcon, CircleCheckIcon, TriangleAlertIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import { ROWS } from '../kit/tone'
import { reportSources } from '../card-status'
import { now, useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { relativeTime } from '../../../lib/relative-time'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t, locale } = useI18n()
const src = useSource('alerts', () => trpc.alert.list.query(), 60_000)
reportSources(src)

const RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 }
const alerts = computed(() => [...(src.data.value ?? [])].sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3) || +new Date(b.lastSeenAt) - +new Date(a.lastSeenAt)))
const critical = computed(() => alerts.value.filter(a => a.severity === 'critical').length)
const warning = computed(() => alerts.value.length - critical.value)
</script>

<template>
  <Empty v-if="src.data.value && !alerts.length" :icon="CircleCheckIcon" tone="ok" :text="t('widgets.alerts.none')" />
  <div v-else-if="src.data.value" class="flex flex-1 flex-col gap-2">
    <p class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span v-if="critical" class="flex items-baseline gap-1.5 text-error"><span class="font-figure text-2xl font-bold tabular-nums">{{ critical }}</span><span class="text-xs">{{ t('widgets.alerts.critical', critical) }}</span></span>
      <span v-if="warning" class="flex items-baseline gap-1.5 text-warning"><span class="font-figure text-2xl font-bold tabular-nums">{{ warning }}</span><span class="text-xs">{{ t('widgets.alerts.warning', warning) }}</span></span>
    </p>
    <ul class="flex flex-col divide-y divide-base-300">
      <li v-for="a in alerts.slice(0, ROWS[props.size] - (props.size === 's' ? 2 : 0))" :key="a.id" class="flex items-start gap-2 py-1.5 text-xs">
        <CircleAlertIcon v-if="a.severity === 'critical'" class="mt-px size-3.5 shrink-0 text-error" :aria-label="t('widgets.alerts.critical', 1)" />
        <TriangleAlertIcon v-else class="mt-px size-3.5 shrink-0 text-warning" :aria-label="t('widgets.alerts.warning', 1)" />
        <span class="min-w-0 flex-1 text-base-content/90 line-clamp-2">{{ a.message }}</span>
        <span class="shrink-0 tabular-nums text-base-content/60" :title="String(a.firstSeenAt)">{{ relativeTime(a.firstSeenAt, now, locale) }}</span>
      </li>
    </ul>
  </div>
</template>
