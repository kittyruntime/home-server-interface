<script setup lang="ts">
import type { Component } from 'vue'
import { ArrowDownIcon, ArrowUpIcon } from '@lucide/vue'

// One instrument of the strip: what it measures, its reading, a level bar.
// The selected one opens its detail under the strip.
defineProps<{
  icon: Component; label: string; value: string; sub: string; level: number | null; color: string; selected: boolean; controls: string
  /** In and out rates, drawn as arrows instead of the sub line's words. */
  flow?: { rx: string; tx: string }
}>()
defineEmits<{ select: [] }>()
</script>

<template>
  <button type="button" :aria-pressed="selected" :aria-controls="controls"
    class="relative flex min-w-0 flex-col gap-1.5 px-4 pt-3.5 pb-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-base-content/30"
    :class="selected ? 'bg-base-200/70' : 'hover:bg-base-200/40'"
    :style="selected ? { boxShadow: `inset 0 2px 0 ${color}` } : undefined"
    @click="$emit('select')">
    <span class="flex items-center gap-1.5 text-xs font-medium text-base-content/70">
      <component :is="icon" class="size-3.5" aria-hidden="true" />{{ label }}
    </span>
    <span class="truncate font-figure text-2xl leading-none tabular-nums text-base-content @5xl:text-3xl">{{ value }}</span>
    <span v-if="flow" class="flex min-w-0 flex-wrap gap-x-3 text-xs tabular-nums text-base-content/70">
      <span class="sr-only">{{ sub }}</span>
      <span class="flex items-center gap-0.5" aria-hidden="true"><ArrowDownIcon class="size-3" />{{ flow.rx }}</span>
      <span class="flex items-center gap-0.5" aria-hidden="true"><ArrowUpIcon class="size-3" />{{ flow.tx }}</span>
    </span>
    <span v-else class="truncate text-xs tabular-nums text-base-content/70">{{ sub }}</span>
    <span class="mt-1 h-1 overflow-hidden rounded-full bg-base-300/60" aria-hidden="true">
      <span v-if="level !== null" class="block h-full rounded-full transition-[width] duration-500 ease-out"
        :style="{ width: `${Math.max(level > 0 ? 2 : 0, Math.min(100, level))}%`, backgroundColor: color }" />
    </span>
  </button>
</template>
