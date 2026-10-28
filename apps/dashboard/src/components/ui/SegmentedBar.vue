<script setup lang="ts">
import { computed } from 'vue'
import { Progress } from '@/components/ui/progress'

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
  <Progress
    :model-value="indeterminate ? null : value"
    :class="['rounded-full bg-muted', heightClass]"
    :indicator-class="['rounded-full', indeterminate && 'w-1/3 animate-[progress-slide_1.2s_ease-in-out_infinite]']"
    :indicator-style="indeterminate ? { backgroundColor: color, transform: 'none' } : { backgroundColor: color }"
  />
</template>

<style>
@keyframes progress-slide {
  from { transform: translateX(-100%); }
  to   { transform: translateX(300%); }
}
</style>
