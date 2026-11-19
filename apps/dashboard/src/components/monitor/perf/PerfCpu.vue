<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import PerfChart from './PerfChart.vue'
import PerfStat from './PerfStat.vue'
import { curve, RESOURCE_COLOR, type Perf } from '../../../lib/perf-live'
import { fmtGhz, fmtUptime } from '../../../lib/perf-math'

defineProps<{ perf: Perf }>()
const { t } = useI18n()
const color = RESOURCE_COLOR.cpu
</script>

<template>
  <div class="space-y-5">
    <PerfChart tall :label="t('monitor.perf.cpuUse')" max-label="100 %" :max="100"
      :series="[{ values: curve('cpu'), color, fill: true }]" />

    <!-- Every core as one column of the same comb, filled to its load. -->
    <div role="group" :aria-label="t('monitor.perf.eachCore')">
      <p class="mb-1.5 text-xs text-base-content/70">{{ t('monitor.perf.eachCore') }}</p>
      <ol class="flex h-16 items-stretch gap-1">
        <li v-for="(v, i) in perf.cpu.perCore" :key="i" class="relative min-w-1 flex-1 overflow-hidden rounded-sm bg-base-300/50"
          :title="`${t('monitor.perf.core', { n: i })}: ${Math.round(v)} %`">
          <span class="absolute inset-x-0 bottom-0 transition-[height] duration-500 ease-out" :style="{ height: `${Math.min(100, v)}%`, backgroundColor: color }" />
          <span class="sr-only">{{ t('monitor.perf.core', { n: i }) }}: {{ Math.round(v) }} %</span>
        </li>
      </ol>
      <p class="mt-1 flex justify-between text-2xs tabular-nums text-base-content/60">
        <span>0</span><span>{{ perf.cpu.perCore.length - 1 }}</span>
      </p>
    </div>

    <dl class="grid grid-cols-2 gap-x-6 gap-y-4 @xl:grid-cols-4">
      <PerfStat :label="t('monitor.perf.speed')" :value="fmtGhz(perf.cpu.mhz)" />
      <PerfStat :label="t('monitor.perf.maxSpeed')" :value="fmtGhz(perf.cpu.maxMhz)" />
      <PerfStat :label="t('monitor.perf.cores')" :value="perf.cpu.cores" />
      <PerfStat :label="t('monitor.perf.load')" :value="perf.cpu.loadavg.map(l => l.toFixed(2)).join(' / ')" />
      <PerfStat :label="t('monitor.perf.processes')" :value="perf.cpu.processes" />
      <PerfStat :label="t('monitor.perf.threads')" :value="perf.cpu.threads" />
      <PerfStat :label="t('monitor.perf.uptime')" :value="fmtUptime(perf.uptime)" />
    </dl>
  </div>
</template>
