<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheckIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import { ROWS } from '../kit/tone'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { mergeActivity } from '../../../lib/activity'
import { activityLabel } from '../../../lib/activity-label'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const src = useSource('tasks', () => trpc.tasks.list.query(), 5_000)
reportSources(src)
const items = computed(() => mergeActivity(src.data.value?.running ?? [], []))
</script>

<template>
  <Empty v-if="src.data.value && !items.length" :icon="CircleCheckIcon" tone="ok" :text="t('widgets.activity.none')" />
  <div v-else-if="src.data.value" class="flex flex-1 flex-col gap-2">
    <p class="text-xs text-base-content/70"><span class="font-figure text-2xl font-bold tabular-nums text-base-content">{{ items.length }}</span> {{ t('widgets.activity.running', items.length) }}</p>
    <ul class="flex flex-col gap-2">
      <li v-for="it in items.slice(0, ROWS[props.size])" :key="it.id" class="flex flex-col gap-1 text-xs">
        <div class="flex items-baseline gap-2">
          <span class="min-w-0 flex-1 truncate text-base-content">{{ activityLabel(it, t) }}</span>
          <span class="shrink-0 tabular-nums text-base-content/70">{{ it.percent != null ? `${Math.round(it.percent)} %` : t(`widgets.activity.status.${it.status === 'queued' ? 'queued' : 'running'}`) }}</span>
        </div>
        <span class="h-1 overflow-hidden rounded-full bg-base-300">
          <span :class="['block h-full rounded-full bg-info', it.percent == null && 'w-1/3 animate-pulse']" :style="it.percent != null ? { width: `${it.percent}%` } : undefined" />
        </span>
      </li>
    </ul>
  </div>
</template>
