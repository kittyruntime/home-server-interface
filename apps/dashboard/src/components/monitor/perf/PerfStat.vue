<script setup lang="ts">
// One measured value under a graph: a small label over the figure.
defineProps<{ label: string; value: string | number; big?: boolean }>()
</script>

<template>
  <div class="min-w-0">
    <dt class="truncate text-xs text-base-content/70">{{ label }}</dt>
    <dd class="truncate tabular-nums text-base-content" :class="big ? 'text-xl font-semibold leading-7' : 'text-sm font-medium'">
      <slot>{{ value }}</slot>
    </dd>
  </div>
</template>
