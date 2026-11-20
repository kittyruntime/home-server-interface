<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { subscribeProcs, procsLoaded } from '../../../lib/proc-live'
import { useOwners } from '../../monitor/rank/use-owners'
import Empty from '../kit/Empty.vue'
import { ROWS } from '../kit/tone'
import type { RankMetric } from '../../../lib/perf-math'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const metric = computed<RankMetric>(() => {
  const m = props.widget.settings?.metric
  return m === 'rss' || m === 'disk' ? m : 'cpu'
})
const { rows } = useOwners(metric)
const shown = computed(() => rows.value.slice(0, ROWS[props.size]))

let stop: (() => void) | null = null
onMounted(() => { stop = subscribeProcs() })
onUnmounted(() => stop?.())
</script>

<template>
  <Empty v-if="procsLoaded && !rows.length" :text="t('widgets.consumers.none')" />
  <div v-else class="flex flex-1 flex-col gap-1">
    <p class="mb-1 text-xs text-base-content/70">{{ t(`widgets.consumers.by.${metric}`) }}</p>
    <ul class="flex flex-col gap-2">
      <li v-for="r in shown" :key="r.key" class="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-xs">
        <component :is="r.icon" class="size-3.5 text-base-content/60" aria-hidden="true" />
        <span class="truncate font-medium text-base-content">{{ r.name }}</span>
        <span class="tabular-nums text-base-content/80">{{ r.value }}</span>
        <span class="col-start-2 col-end-4 h-1 overflow-hidden rounded-full bg-base-300">
          <span class="block h-full rounded-full transition-[width] duration-[var(--dur-base)]" :style="{ width: `${r.level}%`, background: r.color }" />
        </span>
      </li>
    </ul>
  </div>
</template>
