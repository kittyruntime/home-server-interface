<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: 'Loading' })
</script>

<template>
  <span class="inline-flex items-center font-mono text-xs uppercase tracking-wider text-[var(--c-text-3)] loading-blink">
    [{{ label }}]
  </span>
</template>

<style scoped>
.loading-blink {
  animation: loading-blink 1s steps(2, jump-none) infinite;
}
@keyframes loading-blink {
  50% { opacity: 0.35; }
}
</style>
