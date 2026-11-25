<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FanIcon } from '@lucide/vue'
import LiveChart from '../LiveChart.vue'
import PerfStat from './PerfStat.vue'
import { curve, tick, RESOURCE_COLOR } from '../../../lib/perf-live'
import { chipKind, sensorKey, tempTone, type Sensor } from '../../../lib/perf-temps'

// Every temperature sensor, one line each: what it measures, its last two
// minutes, its current value and its limits. Fan speeds under them.
const props = defineProps<{ sensors: Sensor[] }>()
const { t } = useI18n()
const color = RESOURCE_COLOR.temp

const temps = computed(() => props.sensors.filter(s => s.kind === 'temp'))
const fans = computed(() => props.sensors.filter(s => s.kind === 'fan'))
const name = (s: Sensor) => {
  const k = chipKind(s.chip)
  const chip = k ? t(`monitor.perf.chip.${k}`) : s.chip
  return s.label.startsWith(s.chip) ? chip : `${chip} · ${s.label}`
}
// The scale: the critical point when known, else 100 C, raised if a reading goes above.
const top = (s: Sensor) => Math.max(s.crit ?? 100, ...curve(`temp:${sensorKey(s)}`), s.value)
const TEXT = { ok: 'text-base-content', warn: 'text-warning', bad: 'text-error' } as const
const fmt = (v?: number) => v == null ? '-' : `${Math.round(v)} °C`
</script>

<template>
  <div>
    <ul class="divide-y divide-base-300/70">
      <li v-for="s in temps" :key="sensorKey(s)"
        class="grid items-center gap-x-6 gap-y-2 py-3 first:pt-0 @2xl:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,20rem)]">
        <div class="min-w-0">
          <p class="truncate text-sm text-base-content">{{ name(s) }}</p>
          <p class="truncate font-mono text-xs text-base-content/70">{{ s.chip }}</p>
        </div>
        <div class="h-12 overflow-hidden rounded-field border border-base-300 bg-base-100" role="img" :aria-label="`${name(s)}, ${t('monitor.perf.tempWindow')}`">
          <LiveChart :series="[{ values: curve(`temp:${sensorKey(s)}`), color, fill: true }]" :max="top(s)" :tick="tick" />
        </div>
        <dl class="grid grid-cols-3 gap-x-3">
          <PerfStat :label="t('monitor.perf.now')" :value="fmt(s.value)">
            <span :class="TEXT[tempTone(s)]">{{ fmt(s.value) }}<span v-if="tempTone(s) !== 'ok'" class="ml-1 text-2xs uppercase">{{ t(`monitor.perf.tone.${tempTone(s)}`) }}</span></span>
          </PerfStat>
          <PerfStat :label="t('monitor.perf.maxTemp')" :value="fmt(s.max)" />
          <PerfStat :label="t('monitor.perf.critTemp')" :value="fmt(s.crit)" />
        </dl>
      </li>
    </ul>
    <div v-if="fans.length" class="mt-3 border-t border-base-300/70 pt-3">
      <p class="mb-1.5 text-xs font-medium text-base-content/70">{{ t('monitor.perf.fans') }}</p>
      <p class="flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums text-base-content">
        <span v-for="f in fans" :key="sensorKey(f)" class="inline-flex items-center gap-1.5">
          <FanIcon class="size-3.5 text-base-content/70" aria-hidden="true" />{{ f.label }} <span class="text-base-content/80">{{ t('monitor.perf.rpm', { n: f.value }) }}</span>
        </span>
      </p>
    </div>
    <p class="mt-3 text-2xs text-base-content/70">{{ t('monitor.perf.window') }}</p>
  </div>
</template>
