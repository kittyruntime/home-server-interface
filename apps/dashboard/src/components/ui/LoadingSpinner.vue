<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: 'Loading…' })
</script>

<template>
  <span class="inline-flex items-center gap-2">
    <svg class="w-4 h-4 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
    </svg>
    <span v-if="label">{{ label }}</span>
  </span>
</template>
