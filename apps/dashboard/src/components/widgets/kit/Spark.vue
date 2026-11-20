<script setup lang="ts">
import { computed } from 'vue'

// A small line of recent values, scaled to `max` (or to the highest value).
const props = withDefaults(defineProps<{ values: number[]; max?: number; color?: string; fill?: boolean; label?: string }>(), {
  color: 'var(--color-primary)', fill: true,
})

const W = 100, H = 40
const path = computed(() => {
  const v = props.values
  if (v.length < 2) return null
  const top = props.max ?? Math.max(...v, 1)
  const pts = v.map((n, i) => [(i / (v.length - 1)) * W, H - Math.max(0, Math.min(1, n / (top || 1))) * (H - 2) - 1] as const)
  const line = `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}`
  return { line, area: `${line}L${W},${H}L0,${H}Z` }
})
</script>

<template>
  <svg v-if="path" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="block h-full w-full overflow-visible" :role="label ? 'img' : undefined" :aria-label="label" :aria-hidden="label ? undefined : 'true'">
    <path v-if="fill" :d="path.area" :fill="color" opacity="0.12" />
    <path :d="path.line" fill="none" :stroke="color" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
  </svg>
</template>
