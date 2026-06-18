<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  percent: number
  segments?: number
  height?: 'compact' | 'standard' | 'hero'
  color?: string
  indeterminate?: boolean
}>(), {
  segments: 24,
  height: 'compact',
  color: 'var(--c-text-display)',
})

const filled = computed(() => Math.round((Math.max(0, Math.min(100, props.percent)) / 100) * props.segments))

const heightClass = computed(() => ({
  compact: 'h-1',
  standard: 'h-2.5',
  hero: 'h-4',
}[props.height]))
</script>

<template>
  <div class="flex gap-[2px] w-full" :class="heightClass">
    <span
      v-for="i in segments"
      :key="i"
      class="flex-1 rounded-none"
      :class="indeterminate ? 'segbar-pulse' : ''"
      :style="{
        backgroundColor: indeterminate ? 'var(--c-border-strong)' : (i <= filled ? color : 'var(--c-border-strong)'),
        animationDelay: indeterminate ? `${i * 40}ms` : undefined,
      }"
    />
  </div>
</template>

<style scoped>
.segbar-pulse {
  animation: segbar-pulse 1.2s ease-in-out infinite;
}
@keyframes segbar-pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}
</style>
