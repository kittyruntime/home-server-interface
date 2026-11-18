<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import PerfChart from './PerfChart.vue'
import PerfStat from './PerfStat.vue'
import { curve, RESOURCE_COLOR, type Perf } from '../../../lib/perf-live'
import { fmtRate, niceBytes } from '../../../lib/perf-math'
import { formatBytes } from '../../../lib/file-details'

const props = defineProps<{ disk: Perf['disks'][number] }>()
const { t } = useI18n()
const color = RESOURCE_COLOR.disk
const read = computed(() => curve(`disk:${props.disk.name}:read`))
const write = computed(() => curve(`disk:${props.disk.name}:write`))
const max = computed(() => niceBytes([...read.value, ...write.value]))
</script>

<template>
  <div class="space-y-5">
    <PerfChart tall :label="t('monitor.perf.activeTime')" max-label="100 %" :max="100"
      :series="[{ values: curve(`disk:${disk.name}:busy`), color, fill: true }]" />
    <PerfChart :label="t('monitor.perf.transfer')" :max-label="fmtRate(max)" :max="max"
      :series="[{ values: read, color, fill: true }, { values: write, color, dashed: true }]" />

    <dl class="grid grid-cols-2 gap-x-6 gap-y-4 @xl:grid-cols-4">
      <PerfStat big :label="t('monitor.perf.activeTime')" :value="`${Math.round(disk.busy)} %`" />
      <PerfStat big :label="t('monitor.perf.readSpeed')" :value="fmtRate(disk.readBps)" />
      <PerfStat big :label="t('monitor.perf.writeSpeed')" :value="fmtRate(disk.writeBps)" />
      <PerfStat big :label="t('monitor.perf.capacity')" :value="disk.size ? formatBytes(disk.size) : '-'" />
      <PerfStat :label="t('monitor.perf.type')" :value="disk.rotational ? t('monitor.perf.hdd') : t('monitor.perf.ssd')" />
      <PerfStat :label="t('monitor.perf.device')" :value="`/dev/${disk.name}`" />
    </dl>
    <p class="flex flex-wrap gap-x-4 text-2xs text-base-content/70">
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-4" :style="{ backgroundColor: color }" />{{ t('monitor.perf.read') }}</span>
      <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dashed" :style="{ borderColor: color }" />{{ t('monitor.perf.write') }}</span>
    </p>
  </div>
</template>
