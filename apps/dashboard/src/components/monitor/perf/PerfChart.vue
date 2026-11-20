<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import LiveChart, { type ChartSeries } from '../LiveChart.vue'
import { tick } from '../../../lib/perf-live'

// A graph with its scale written around it: what it measures and its top on
// the first line, the time span and zero under it.
defineProps<{ label: string; maxLabel: string; series: ChartSeries[]; max: number; tall?: boolean }>()
const { t } = useI18n()
</script>

<template>
  <div class="min-w-0" role="group" :aria-label="label">
    <div class="mb-1 flex items-baseline justify-between gap-3 text-xs text-base-content/70">
      <span class="truncate">{{ label }}</span>
      <span class="shrink-0 tabular-nums">{{ maxLabel }}</span>
    </div>
    <div class="overflow-hidden rounded-field border border-base-300 bg-base-100" :class="tall ? 'h-48 @3xl:h-60' : 'h-24'">
      <LiveChart :series="series" :max="max" :tick="tick" />
    </div>
    <div class="mt-1 flex justify-between text-2xs text-base-content/60">
      <span>{{ t('monitor.perf.window') }}</span>
      <span>0</span>
    </div>
  </div>
</template>
