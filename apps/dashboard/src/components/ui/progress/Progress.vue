<script setup lang="ts">
import type { HTMLAttributes, StyleValue } from "vue"
import { computed } from "vue"
import { cn } from "@/lib/utils"

// A native <progress> cannot take the callers' indicator classes (bg-*,
// width, transform for the indeterminate sweep), so the bar stays a div pair.
const props = withDefaults(
  defineProps<{
    /** Percentage of `max`. null renders the indeterminate state. */
    modelValue?: number | null
    max?: number
    class?: HTMLAttributes["class"]
    indicatorClass?: HTMLAttributes["class"]
    indicatorStyle?: StyleValue
  }>(),
  {
    modelValue: 0,
    max: 100,
  },
)

const indeterminate = computed(() => props.modelValue == null)
const percent = computed(() => {
  if (props.modelValue == null)
    return 0
  return Math.max(0, Math.min(100, props.modelValue / props.max * 100))
})
const state = computed(() => {
  if (indeterminate.value)
    return "indeterminate"
  return percent.value >= 100 ? "complete" : "loading"
})
</script>

<template>
  <div
    role="progressbar"
    data-slot="progress"
    :data-state="state"
    :aria-label="indeterminate ? undefined : `${Math.round(percent)}%`"
    aria-valuemin="0"
    :aria-valuemax="max"
    :aria-valuenow="indeterminate ? undefined : modelValue ?? undefined"
    :class="cn('bg-primary/20 relative h-2 w-full overflow-hidden rounded-full', props.class)"
  >
    <div
      data-slot="progress-indicator"
      :data-state="state"
      :class="cn('bg-primary h-full w-full flex-1 transition-all', props.indicatorClass)"
      :style="[`transform: translateX(-${100 - percent}%);`, props.indicatorStyle]"
    />
  </div>
</template>
