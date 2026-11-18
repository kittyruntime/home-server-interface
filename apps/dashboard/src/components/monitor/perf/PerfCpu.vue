<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import LiveChart from '../LiveChart.vue'
import PerfChart from './PerfChart.vue'
import PerfStat from './PerfStat.vue'
import { curve, tick, RESOURCE_COLOR, type Perf } from '../../../lib/perf-live'
import { fmtGhz, fmtUptime } from '../../../lib/perf-math'

defineProps<{ perf: Perf }>()
const { t } = useI18n()
const view = ref<'total' | 'cores'>('total')
const color = RESOURCE_COLOR.cpu
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <ToggleGroup type="single" variant="tabs" size="sm" :model-value="view" :aria-label="t('monitor.perf.graphOf')"
        @update:model-value="v => { if (v === 'total' || v === 'cores') view = v }">
        <ToggleGroupItem value="total">{{ t('monitor.perf.overall') }}</ToggleGroupItem>
        <ToggleGroupItem value="cores">{{ t('monitor.perf.eachCore') }}</ToggleGroupItem>
      </ToggleGroup>
    </div>

    <PerfChart v-if="view === 'total'" tall :label="t('monitor.perf.cpuUse')" max-label="100 %" :max="100"
      :series="[{ values: curve('cpu'), color, fill: true }]" />
    <ul v-else class="grid gap-2 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
      <li v-for="(v, i) in perf.cpu.perCore" :key="i">
        <div class="mb-1 flex justify-between text-2xs text-base-content/70">
          <span>{{ t('monitor.perf.core', { n: i }) }}</span>
          <span class="tabular-nums">{{ Math.round(v) }} %</span>
        </div>
        <div class="h-20 overflow-hidden rounded-field border border-base-300 bg-base-100">
          <LiveChart :series="[{ values: curve(`core:${i}`), color, fill: true }]" :max="100" :tick="tick" />
        </div>
      </li>
    </ul>

    <dl class="grid grid-cols-2 gap-x-6 gap-y-4 @xl:grid-cols-4">
      <PerfStat big :label="t('monitor.perf.utilization')" :value="`${Math.round(perf.cpu.usage)} %`" />
      <PerfStat big :label="t('monitor.perf.speed')" :value="fmtGhz(perf.cpu.mhz)" />
      <PerfStat big :label="t('monitor.perf.processes')" :value="perf.cpu.processes" />
      <PerfStat big :label="t('monitor.perf.threads')" :value="perf.cpu.threads" />
      <PerfStat :label="t('monitor.perf.uptime')" :value="fmtUptime(perf.uptime)" />
      <PerfStat :label="t('monitor.perf.load')" :value="perf.cpu.loadavg.map(l => l.toFixed(2)).join(' / ')" />
      <PerfStat :label="t('monitor.perf.cores')" :value="perf.cpu.cores" />
      <PerfStat :label="t('monitor.perf.maxSpeed')" :value="fmtGhz(perf.cpu.maxMhz)" />
    </dl>
  </div>
</template>
