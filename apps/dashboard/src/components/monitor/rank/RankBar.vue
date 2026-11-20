<script setup lang="ts">
// A measured share drawn as a bar with its value, the ranking's only figure.
defineProps<{ level: number; value: string; color: string; thin?: boolean }>()
</script>

<template>
  <span class="flex min-w-0 items-center gap-2.5">
    <span class="relative flex-1 overflow-hidden rounded-full bg-base-300/60" :class="thin ? 'h-1' : 'h-1.5'" aria-hidden="true">
      <span class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
        :style="{ width: `${level > 0 ? Math.max(2, level) : 0}%`, backgroundColor: color }" />
    </span>
    <span class="w-14 shrink-0 text-right tabular-nums @md:w-16" :class="thin ? 'text-xs text-base-content/90' : 'text-sm font-medium text-base-content'">{{ value }}</span>
  </span>
</template>
