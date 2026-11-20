<script setup lang="ts">
// A key number in the instrument font, with its unit and a line under it.
defineProps<{ value: string | number; unit?: string; sub?: string; toneClass?: string }>()
</script>

<template>
  <div class="min-w-0">
    <p :class="['font-figure text-3xl font-bold leading-none tabular-nums @[16rem]:text-4xl', toneClass ?? 'text-base-content']">
      {{ value }}<span v-if="unit" class="ml-1 text-base font-normal text-base-content/60">{{ unit }}</span>
    </p>
    <p v-if="sub" class="mt-1.5 truncate text-xs tabular-nums text-base-content/70">{{ sub }}</p>
  </div>
</template>
