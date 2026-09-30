<script setup lang="ts">
import LoadingSpinner from './LoadingSpinner.vue'

// Content of a button whose action is running: the spinner (1em, the
// button's text color) before the label, and `busyLabel` in place of the
// label when given. The button itself stays responsible for `disabled`.
defineProps<{ busy: boolean; busyLabel?: string }>()
</script>

<template>
  <span class="inline-flex items-center gap-1.5">
    <LoadingSpinner v-if="busy" />
    <span v-if="busy && busyLabel">{{ busyLabel }}…</span>
    <slot v-else />
  </span>
</template>
