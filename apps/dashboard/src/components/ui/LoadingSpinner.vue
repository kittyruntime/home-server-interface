<script setup lang="ts">
import { Spinner } from '@/components/ui/spinner'

// The one spinner of the dashboard. Glyph only by default; it takes the text
// color and size (1em) of where it sits. A label turns it into a status line.
// Under reduced motion the glyph stops and the label blinks instead.
withDefaults(defineProps<{ label?: string }>(), { label: '' })
</script>

<template>
  <span role="status" :aria-label="label || 'Loading'" :class="['inline-flex items-center gap-1.5', label ? 'status-text uppercase' : '']">
    <Spinner role="presentation" aria-hidden="true" aria-label="" class="size-[1em] shrink-0 motion-reduce:animate-none" />
    <span v-if="label" class="motion-reduce:animate-pulse">{{ label }}</span>
  </span>
</template>
