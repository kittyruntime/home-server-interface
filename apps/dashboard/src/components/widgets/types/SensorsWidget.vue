<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FanIcon, ThermometerIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import Figure from '../kit/Figure.vue'
import { ROWS, TEXT, type Tone } from '../kit/tone'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'
import { chipKind, hottest as hottestOf, tempTone } from '../../../lib/perf-temps'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const src = useSource('sensors', () => trpc.dashboard.sensors.query(), 10_000)
reportSources(src)

type Sensor = NonNullable<typeof src.data.value>[number]
const chipName = (chip: string) => { const k = chipKind(chip); return k ? t(`widgets.sensors.chip.${k}`) : chip }

const tone = (s: Sensor): Tone => s.kind === 'temp' ? tempTone(s) : 'neutral'

const temps = computed(() => (src.data.value ?? []).filter(s => s.kind === 'temp'))
const fans = computed(() => (src.data.value ?? []).filter(s => s.kind === 'fan'))
const hottest = computed(() => hottestOf(temps.value))
const rows = computed(() => [...temps.value].sort((a, b) => b.value - a.value).slice(0, ROWS[props.size]))
const label = (s: Sensor) => s.label.startsWith(s.chip) ? chipName(s.chip) : `${chipName(s.chip)} · ${s.label}`
</script>

<template>
  <Empty v-if="src.data.value && !src.data.value.length" :icon="ThermometerIcon" :text="t('widgets.sensors.none')" />
  <div v-else-if="hottest" class="flex flex-1 flex-col gap-3">
    <Figure :value="Math.round(hottest.value)" unit="°C" :sub="t('widgets.sensors.hottest', { name: label(hottest) })" :tone-class="tone(hottest) === 'ok' ? undefined : TEXT[tone(hottest)]" />
    <ul v-if="size !== 's'" class="flex flex-col divide-y divide-base-300 text-xs">
      <li v-for="s in rows" :key="s.chip + s.label" class="flex items-center gap-2 py-1.5">
        <span class="min-w-0 flex-1 truncate text-base-content/80">{{ label(s) }}</span>
        <span :class="['font-medium tabular-nums', tone(s) === 'ok' ? 'text-base-content' : TEXT[tone(s)]]">{{ s.value.toFixed(0) }} °C</span>
        <span v-if="tone(s) !== 'ok'" :class="['text-2xs uppercase tracking-caps', TEXT[tone(s)]]">{{ t(`widgets.tone.${tone(s)}`) }}</span>
      </li>
    </ul>
    <p v-if="fans.length && size === 'l'" class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/70">
      <span v-for="f in fans" :key="f.chip + f.label" class="flex items-center gap-1 tabular-nums"><FanIcon class="size-3.5" aria-hidden="true" />{{ f.label }} {{ t('widgets.sensors.rpm', { n: f.value }) }}</span>
    </p>
  </div>
</template>
