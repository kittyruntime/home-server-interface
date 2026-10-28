<script setup lang="ts">
import { Loader2Icon } from '@lucide/vue'

// The one spinner of the dashboard. Glyph only by default; it takes the text
// color and size (1em) of where it sits. A label turns it into a status line.
// Under reduced motion the glyph stops and the label blinks instead.
withDefaults(defineProps<{ label?: string }>(), { label: '' })
</script>

<template>
  <span role="status" :aria-label="label || 'Loading'" :class="['inline-flex items-center gap-1.5', label ? 'status-text uppercase' : '']">
    <Loader2Icon class="size-[1em] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    <span v-if="label" class="motion-reduce:animate-pulse">{{ label }}</span>
  </span>
</template>
