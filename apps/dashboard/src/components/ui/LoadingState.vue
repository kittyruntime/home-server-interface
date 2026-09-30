<script setup lang="ts">
import LoadingSpinner from './LoadingSpinner.vue'
import { LOADING } from '../../lib/loading'

// Something is being fetched and there is nothing to show yet.
//   block   – centered in an empty section (first load)
//   compact – same, in a smaller area (a card, a dialog)
//   inline  – on a line of its own, left-aligned, in running content
// It appears only after 200 ms, so fast loads do not flash a spinner.
withDefaults(defineProps<{ label?: string; variant?: 'block' | 'compact' | 'inline' }>(), {
  label: LOADING.default,
  variant: 'block',
})
</script>

<template>
  <div
    role="status"
    aria-live="polite"
    :class="[
      'loading-appear flex items-center text-[var(--c-text-3)]',
      variant === 'block' ? 'justify-center gap-2.5 py-12 text-sm'
        : variant === 'compact' ? 'justify-center gap-2 py-4 text-xs'
        : 'gap-2 text-sm',
    ]"
  >
    <LoadingSpinner />
    <span>{{ label }}…</span>
  </div>
</template>
