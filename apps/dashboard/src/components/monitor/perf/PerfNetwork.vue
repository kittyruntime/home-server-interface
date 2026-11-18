<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import PerfChart from './PerfChart.vue'
import PerfStat from './PerfStat.vue'
import { curve, RESOURCE_COLOR, type Perf } from '../../../lib/perf-live'
import { fmtRate, niceBytes } from '../../../lib/perf-math'

const props = defineProps<{ net: Perf['nets'][number] }>()
const { t } = useI18n()
const color = RESOURCE_COLOR.net
const rx = computed(() => curve(`net:${props.net.name}:rx`))
const tx = computed(() => curve(`net:${props.net.name}:tx`))
const max = computed(() => niceBytes([...rx.value, ...tx.value]))
const v4 = computed(() => props.net.addrs.filter(a => a.family === 'IPv4').map(a => a.addr))
const v6 = computed(() => props.net.addrs.filter(a => a.family === 'IPv6').map(a => a.addr))
</script>

<template>
  <div class="space-y-5">
    <PerfChart tall :label="t('monitor.perf.throughput')" :max-label="fmtRate(max)" :max="max"
      :series="[{ values: rx, color, fill: true }, { values: tx, color, dashed: true }]" />
    <p class="flex flex-wrap gap-x-4 text-2xs text-base-content/70">
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-4" :style="{ backgroundColor: color }" />{{ t('monitor.perf.receive') }}</span>
      <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dashed" :style="{ borderColor: color }" />{{ t('monitor.perf.send') }}</span>
    </p>

    <dl class="grid grid-cols-2 gap-x-6 gap-y-4 @xl:grid-cols-4">
      <PerfStat big :label="t('monitor.perf.receive')" :value="fmtRate(net.rxBps)" />
      <PerfStat big :label="t('monitor.perf.send')" :value="fmtRate(net.txBps)" />
      <PerfStat big :label="t('monitor.perf.link')"
        :value="!net.up ? t('monitor.perf.down') : net.speedMbps ? (net.speedMbps >= 1000 ? `${net.speedMbps / 1000} Gb/s` : `${net.speedMbps} Mb/s`) : t('monitor.perf.up')" />
      <PerfStat big :label="t('monitor.perf.mac')" :value="net.mac ?? '-'" class="[&_dd]:font-mono [&_dd]:text-base" />
      <PerfStat :label="t('monitor.perf.ipv4')" :value="v4.join(', ') || '-'" class="@xl:col-span-2" />
      <PerfStat :label="t('monitor.perf.ipv6')" :value="v6.join(', ') || '-'" class="@xl:col-span-2" />
    </dl>
  </div>
</template>
