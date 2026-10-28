<script setup lang="ts">
import { computed } from 'vue'
import { ProgressIndicator, ProgressRoot } from 'reka-ui'

// Usage bar (disks, memory, operations): the shadcn-vue progress track with a
// caller-chosen fill color. `segments` is kept for callers and ignored.
const props = withDefaults(defineProps<{
  percent: number
  segments?: number
  height?: 'compact' | 'standard' | 'hero'
  color?: string
  indeterminate?: boolean
}>(), {
  segments: 24,
  height: 'compact',
  color: 'var(--primary)',
})

const value = computed(() => Math.max(0, Math.min(100, props.percent)))

const heightClass = computed(() => ({
  compact: 'h-1',
  standard: 'h-2',
  hero: 'h-3',
}[props.height]))
</script>

<template>
  <ProgressRoot
    data-slot="progress"
    :model-value="indeterminate ? null : value"
    :class="['relative w-full overflow-hidden rounded-full bg-muted', heightClass]"
  >
    <ProgressIndicator
      data-slot="progress-indicator"
      :class="['h-full rounded-full transition-all', indeterminate ? 'w-1/3 animate-[progress-slide_1.2s_ease-in-out_infinite]' : 'w-full']"
      :style="{
        backgroundColor: color,
        transform: indeterminate ? undefined : `translateX(-${100 - value}%)`,
      }"
    />
  </ProgressRoot>
</template>

<style>
@keyframes progress-slide {
  from { transform: translateX(-100%); }
  to   { transform: translateX(300%); }
}
</style>
