<script setup lang="ts">
import { computed } from 'vue'
import { CAPACITY } from '../../lib/perf-live'

// A scrolling graph of the last samples, newest on the right. The vertical
// grid moves with time, the way a recorder's paper does.
export interface ChartSeries {
  values: number[]
  /** A CSS color, usually a theme variable. */
  color: string
  fill?: boolean
  dashed?: boolean
}

const props = withDefaults(defineProps<{
  series: ChartSeries[]
  max: number
  tick?: number
  grid?: boolean
}>(), { tick: 0, grid: true })

const step = 100 / (CAPACITY - 1)

function points(values: number[]): [number, number][] {
  const n = values.length
  return values.map((v, i) => [(CAPACITY - n + i) * step, 100 - Math.min(1, Math.max(0, v / (props.max || 1))) * 100])
}

const paths = computed(() => props.series.map(s => {
  const pts = points(s.values)
  if (pts.length < 2) return { ...s, line: '', area: '' }
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('')
  return { ...s, line, area: `M${pts[0]![0].toFixed(2)},100${line.replace(/^M/, 'L')}L100,100Z` }
}))

const verticals = computed(() => {
  const out: number[] = []
  for (let x = 100 - (props.tick % 10) * step; x > 0; x -= 10 * step) out.push(x)
  return out
})
</script>

<template>
  <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="block size-full" aria-hidden="true">
    <g v-if="grid" class="text-base-content/8" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke">
      <line v-for="y in [25, 50, 75]" :key="'h' + y" x1="0" x2="100" :y1="y" :y2="y" vector-effect="non-scaling-stroke" />
      <line v-for="x in verticals" :key="'v' + x" :x1="x" :x2="x" y1="0" y2="100" vector-effect="non-scaling-stroke" />
    </g>
    <g v-for="(p, i) in paths" :key="i" :style="{ color: p.color }">
      <path v-if="p.fill" :d="p.area" fill="currentColor" fill-opacity="0.16" />
      <path :d="p.line" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"
        :stroke-dasharray="p.dashed ? '4 3' : undefined" vector-effect="non-scaling-stroke" />
    </g>
  </svg>
</template>
