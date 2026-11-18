<script setup lang="ts">
import LiveChart from '../LiveChart.vue'

// One resource in the list: a small live graph and its current figure.
defineProps<{ title: string; value: string; sub?: string; values: number[]; max: number; color: string; selected: boolean }>()
defineEmits<{ select: [] }>()
</script>

<template>
  <button type="button" :aria-pressed="selected"
    class="group flex w-full min-w-0 items-center gap-3 rounded-field border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-base-content/30"
    :class="selected ? 'border-base-300 bg-base-200' : 'border-transparent hover:bg-base-200/60'"
    @click="$emit('select')">
    <span class="h-10 w-16 shrink-0 overflow-hidden rounded-sm border bg-base-100" :style="{ borderColor: color }">
      <LiveChart :series="[{ values, color, fill: true }]" :max="max" :grid="false" />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-medium text-base-content">{{ title }}</span>
      <span class="block truncate text-xs tabular-nums text-base-content/80">{{ value }}</span>
      <span v-if="sub" class="block truncate text-2xs text-base-content/60">{{ sub }}</span>
    </span>
  </button>
</template>
