<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import PerfChart from './PerfChart.vue'
import PerfStat from './PerfStat.vue'
import { curve, RESOURCE_COLOR, type Perf } from '../../../lib/perf-live'
import { formatBytes } from '../../../lib/file-details'

const props = defineProps<{ perf: Perf }>()
const { t } = useI18n()
const color = RESOURCE_COLOR.mem

// In use, then cache the system gives back on demand, then free.
const parts = computed(() => {
  const m = props.perf.memory
  const total = m.total || 1
  const cache = Math.min(m.available, m.cached + m.buffers)
  return [
    { key: 'inUse', bytes: m.used, pct: (m.used / total) * 100, style: { backgroundColor: color } },
    { key: 'cached', bytes: cache, pct: (cache / total) * 100, style: { backgroundColor: color, opacity: 0.4 } },
    { key: 'free', bytes: Math.max(0, m.available - cache), pct: (Math.max(0, m.available - cache) / total) * 100, style: {} },
  ]
})
</script>

<template>
  <div class="space-y-5">
    <PerfChart tall :label="t('monitor.perf.memUse')" :max-label="formatBytes(perf.memory.total)" :max="100"
      :series="[{ values: curve('mem'), color, fill: true }]" />

    <div>
      <p class="mb-1 text-xs text-base-content/70">{{ t('monitor.perf.composition') }}</p>
      <div class="flex h-6 overflow-hidden rounded-field border border-base-300 bg-base-100">
        <div v-for="p in parts" :key="p.key" class="h-full border-r border-base-100 last:border-r-0 transition-[width] duration-500"
          :style="{ width: `${p.pct}%`, ...p.style }" :title="`${t(`monitor.perf.${p.key}`)}: ${formatBytes(p.bytes)}`" />
      </div>
      <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/80">
        <li v-for="p in parts" :key="p.key" class="flex items-center gap-1.5">
          <span class="size-2.5 rounded-xs border border-base-300" :style="p.style" aria-hidden="true" />
          {{ t(`monitor.perf.${p.key}`) }} <span class="tabular-nums text-base-content/70">{{ formatBytes(p.bytes) }}</span>
        </li>
      </ul>
    </div>

    <dl class="grid grid-cols-2 gap-x-6 gap-y-4 @xl:grid-cols-4">
      <PerfStat big :label="t('monitor.perf.inUse')" :value="formatBytes(perf.memory.used)" />
      <PerfStat big :label="t('monitor.perf.available')" :value="formatBytes(perf.memory.available)" />
      <PerfStat big :label="t('monitor.perf.cached')" :value="formatBytes(perf.memory.cached + perf.memory.buffers)" />
      <PerfStat big :label="t('monitor.perf.total')" :value="formatBytes(perf.memory.total)" />
      <PerfStat :label="t('monitor.perf.swap')"
        :value="perf.memory.swapTotal ? `${formatBytes(perf.memory.swapUsed)} / ${formatBytes(perf.memory.swapTotal)}` : t('monitor.perf.noSwap')" />
    </dl>
  </div>
</template>
