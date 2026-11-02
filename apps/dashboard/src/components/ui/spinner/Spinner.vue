<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <!-- daisyUI stops the glyph under prefers-reduced-motion by itself -->
  <span
    role="status"
    aria-label="Loading"
    :class="cn('loading loading-spinner size-4', props.class)"
  />
</template>
