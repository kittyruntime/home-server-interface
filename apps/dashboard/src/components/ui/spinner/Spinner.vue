<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <!-- Under prefers-reduced-motion style.css swaps the glyph for a static arc -->
  <span
    role="status"
    aria-label="Loading"
    :class="cn('loading loading-spinner size-4', props.class)"
  />
</template>
