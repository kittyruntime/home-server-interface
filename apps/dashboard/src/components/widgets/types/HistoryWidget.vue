<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Spark from '../kit/Spark.vue'
import Empty from '../kit/Empty.vue'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { fmtRate } from '../../../lib/perf-math'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const period = computed(() => props.widget.settings?.period === '7d' ? '7d' : '24h')
const metric = computed(() => {
  const m = props.widget.settings?.metric
  return m === 'memory' || m === 'network' ? m : 'cpu'
})
// One source per period: two history widgets on the same period share it. The
// card mounts the widget again when its settings change.
const p = period.value
const source = useSource(`history:${p}`, () => trpc.system.metricsHistory.query({ period: p }), p === '7d' ? 900_000 : 300_000)
const src = computed(() => source)
reportSources(source)

const series = computed(() => {
  const rows = src.value.data.value ?? []
  if (metric.value === 'cpu') return { a: rows.map(r => r.cpuPct), b: null, max: 100 }
  if (metric.value === 'memory') return { a: rows.map(r => (Number(r.ramUsed) / Math.max(1, Number(r.ramTotal))) * 100), b: null, max: 100 }
  const a = rows.map(r => Number(r.netRxBps)), b = rows.map(r => Number(r.netTxBps))
  return { a, b, max: Math.max(1024, ...a, ...b) }
})
const avg = computed(() => series.value.a.length ? series.value.a.reduce((x, y) => x + y, 0) / series.value.a.length : 0)
const peak = computed(() => Math.max(0, ...series.value.a))
const fmt = (v: number) => metric.value === 'network' ? fmtRate(v) : `${Math.round(v)} %`
</script>

<template>
  <Empty v-if="src.data.value && src.data.value.length < 2" :text="t('widgets.history.empty')" />
  <div v-else class="flex flex-1 flex-col gap-2">
    <p class="text-xs text-base-content/70">{{ t(`widgets.history.metric.${metric}`) }} · {{ t(`widgets.history.period.${period}`) }}</p>
    <div class="relative min-h-16 flex-1">
      <div class="absolute inset-0"><Spark :values="series.a" :max="series.max" /></div>
      <div v-if="series.b" class="absolute inset-0"><Spark :values="series.b" :max="series.max" color="var(--color-secondary)" :fill="false" /></div>
    </div>
    <dl class="flex gap-6 text-xs">
      <div><dt class="text-base-content/60">{{ t('widgets.history.average') }}</dt><dd class="font-medium tabular-nums">{{ fmt(avg) }}</dd></div>
      <div><dt class="text-base-content/60">{{ t('widgets.history.peak') }}</dt><dd class="font-medium tabular-nums">{{ fmt(peak) }}</dd></div>
      <div v-if="metric === 'network'" class="ml-auto flex items-end gap-3 text-base-content/60">
        <span class="flex items-center gap-1"><span class="size-2 rounded-full bg-primary" />{{ t('widgets.network.in') }}</span>
        <span class="flex items-center gap-1"><span class="size-2 rounded-full bg-secondary" />{{ t('widgets.network.out') }}</span>
      </div>
    </dl>
  </div>
</template>
