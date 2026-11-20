<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import LiveChart from '../LiveChart.vue'
import PerfStat from './PerfStat.vue'
import { curve, tick, RESOURCE_COLOR, type Perf } from '../../../lib/perf-live'
import { fmtRate, niceBytes } from '../../../lib/perf-math'
import { formatBytes } from '../../../lib/file-details'

// Every disk at once, one line each: what it is, its transfers over the last
// two minutes (read solid, write dashed), and its current figures.
defineProps<{ disks: Perf['disks'] }>()
const { t } = useI18n()
const color = RESOURCE_COLOR.disk
const series = (name: string) => [
  { values: curve(`disk:${name}:read`), color, fill: true },
  { values: curve(`disk:${name}:write`), color, dashed: true },
]
const top = (name: string) => niceBytes([...curve(`disk:${name}:read`), ...curve(`disk:${name}:write`)])
</script>

<template>
  <div>
    <ul class="divide-y divide-base-300/70">
      <li v-for="d in disks" :key="d.name"
        class="grid items-center gap-x-6 gap-y-2 py-3 first:pt-0 @2xl:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,20rem)]">
        <div class="min-w-0">
          <p class="truncate font-mono text-sm text-base-content">/dev/{{ d.name }}</p>
          <p class="truncate text-xs text-base-content/70" :title="d.model ?? undefined">
            {{ [d.rotational ? t('monitor.perf.hdd') : t('monitor.perf.ssd'), d.size ? formatBytes(d.size) : '', d.model].filter(Boolean).join(' · ') }}
          </p>
        </div>
        <div class="h-12 overflow-hidden rounded-field border border-base-300 bg-base-100" role="img"
          :aria-label="`${t('monitor.perf.transfer')}, ${t('monitor.perf.window')}`">
          <LiveChart :series="series(d.name)" :max="top(d.name)" :tick="tick" />
        </div>
        <dl class="grid grid-cols-3 gap-x-3">
          <PerfStat :label="t('monitor.perf.activeTime')" :value="`${Math.round(d.busy)} %`" />
          <PerfStat :label="t('monitor.perf.read')" :value="fmtRate(d.readBps)" />
          <PerfStat :label="t('monitor.perf.write')" :value="fmtRate(d.writeBps)" />
        </dl>
      </li>
    </ul>
    <p class="mt-3 flex flex-wrap gap-x-4 text-2xs text-base-content/70">
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-4" :style="{ backgroundColor: color }" aria-hidden="true" />{{ t('monitor.perf.read') }}</span>
      <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dashed" :style="{ borderColor: color }" aria-hidden="true" />{{ t('monitor.perf.write') }}</span>
      <span>{{ t('monitor.perf.window') }}</span>
    </p>
  </div>
</template>
