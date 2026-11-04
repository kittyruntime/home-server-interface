<script setup lang="ts">
// Filled two-tone folder, drawn in currentColor: the back sheet and tab are a
// lighter tint of the front, so it reads as a folder in every theme without
// a fixed palette. `open` tilts the front sheet forward.
defineProps<{ open?: boolean }>()
</script>

<template>
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path
      opacity="0.55"
      d="M2.5 6.25A2.25 2.25 0 0 1 4.75 4h4.13c.6 0 1.17.24 1.6.66l1.2 1.21c.24.23.55.37.89.37h6.68a2.25 2.25 0 0 1 2.25 2.25v9.26A2.25 2.25 0 0 1 19.25 20H4.75a2.25 2.25 0 0 1-2.25-2.25z"
    />
    <path
      v-if="open"
      d="M5.07 10.2A1.75 1.75 0 0 1 6.75 9h14.1a1.25 1.25 0 0 1 1.2 1.6l-2.02 7.78A2.25 2.25 0 0 1 17.85 20H4.4a1.25 1.25 0 0 1-1.2-1.6z"
    />
    <path
      v-else
      d="M2.5 10.25A1.75 1.75 0 0 1 4.25 8.5h15.5a1.75 1.75 0 0 1 1.75 1.75v7.5A2.25 2.25 0 0 1 19.25 20H4.75a2.25 2.25 0 0 1-2.25-2.25z"
    />
  </svg>
</template>
