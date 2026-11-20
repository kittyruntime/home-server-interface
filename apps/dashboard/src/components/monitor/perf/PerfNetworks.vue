<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import LiveChart from '../LiveChart.vue'
import PerfStat from './PerfStat.vue'
import { curve, tick, RESOURCE_COLOR, type Perf } from '../../../lib/perf-live'
import { fmtRate, niceBytes } from '../../../lib/perf-math'

// Every network port at once, one line each, like the disks.
defineProps<{ nets: Perf['nets'] }>()
const { t } = useI18n()
const color = RESOURCE_COLOR.net
const series = (name: string) => [
  { values: curve(`net:${name}:rx`), color, fill: true },
  { values: curve(`net:${name}:tx`), color, dashed: true },
]
const top = (name: string) => niceBytes([...curve(`net:${name}:rx`), ...curve(`net:${name}:tx`)])
const link = (n: Perf['nets'][number]) =>
  !n.up ? t('monitor.perf.down') : n.speedMbps ? (n.speedMbps >= 1000 ? `${n.speedMbps / 1000} Gb/s` : `${n.speedMbps} Mb/s`) : t('monitor.perf.up')
const addrs = (n: Perf['nets'][number], family: string) => n.addrs.filter(a => a.family === family).map(a => a.addr).join(', ')
</script>

<template>
  <div>
    <ul class="divide-y divide-base-300/70">
      <li v-for="n in nets" :key="n.name"
        class="grid items-center gap-x-6 gap-y-2 py-3 first:pt-0 @2xl:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,20rem)]">
        <div class="min-w-0">
          <p class="flex items-center gap-2">
            <span class="size-2 shrink-0 rounded-full" :class="n.up ? 'bg-success' : 'bg-base-content/30'" aria-hidden="true" />
            <span class="truncate font-mono text-sm text-base-content">{{ n.name }}</span>
          </p>
          <p class="truncate text-xs text-base-content/70">{{ [link(n), addrs(n, 'IPv4')].filter(Boolean).join(' · ') }}</p>
          <p v-if="n.mac" class="truncate font-mono text-2xs text-base-content/60" :title="addrs(n, 'IPv6') || undefined">{{ n.mac }}</p>
        </div>
        <div class="h-12 overflow-hidden rounded-field border border-base-300 bg-base-100" role="img"
          :aria-label="`${t('monitor.perf.throughput')}, ${t('monitor.perf.window')}`">
          <LiveChart :series="series(n.name)" :max="top(n.name)" :tick="tick" />
        </div>
        <dl class="grid grid-cols-3 gap-x-3">
          <PerfStat :label="t('monitor.perf.receive')" :value="fmtRate(n.rxBps)" />
          <PerfStat :label="t('monitor.perf.send')" :value="fmtRate(n.txBps)" />
          <PerfStat :label="t('monitor.perf.link')" :value="link(n)" />
        </dl>
      </li>
    </ul>
    <p class="mt-3 flex flex-wrap gap-x-4 text-2xs text-base-content/70">
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-4" :style="{ backgroundColor: color }" aria-hidden="true" />{{ t('monitor.perf.receive') }}</span>
      <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dashed" :style="{ borderColor: color }" aria-hidden="true" />{{ t('monitor.perf.send') }}</span>
      <span>{{ t('monitor.perf.window') }}</span>
    </p>
  </div>
</template>
