<script setup lang="ts">
// The one spinner of the dashboard. Glyph only by default; it takes the text
// color and size (1em) of where it sits. A label turns it into a status line.
withDefaults(defineProps<{ label?: string }>(), { label: '' })
</script>

<template>
  <span :class="['inline-flex items-center gap-1.5', label ? 'status-text uppercase' : '']">
    <!-- 3/4-turn arc; circumference of r=6.5 is ~40.84 so 30.6/10.2 leaves a rounded gap -->
    <svg class="spinner-arc w-[1em] h-[1em] shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle
        cx="8" cy="8" r="6.5"
        stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-dasharray="30.6 10.2"
      />
    </svg>
    <span v-if="label" class="spinner-label">{{ label }}</span>
  </span>
</template>

<style scoped>
/* Literal duration on purpose: the --dur-* motion tokens collapse to ~1ms
   under prefers-reduced-motion, which would turn an infinite rotation into
   a strobe. Reduced motion is handled explicitly below instead. */
.spinner-arc {
  animation: spinner-rotate 0.8s linear infinite;
}
@keyframes spinner-rotate {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .spinner-arc { animation: none; }
  .spinner-label {
    animation: spinner-blink 1s steps(2, jump-none) infinite;
  }
}
@keyframes spinner-blink {
  50% { opacity: 0.35; }
}
</style>
