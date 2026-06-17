<script setup lang="ts">
defineProps<{ active: boolean; dir: 'asc' | 'desc' }>()
defineEmits<{ click: [] }>()
</script>

<template>
  <button @click="$emit('click')" class="inline-flex items-center gap-1 hover:text-[var(--c-text-1)] transition-colors">
    <slot />
    <svg
      class="w-3 h-3 transition-transform shrink-0"
      :class="active ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-3)] opacity-40'"
      :style="{ transform: active && dir === 'desc' ? 'rotate(180deg)' : undefined }"
      fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/>
    </svg>
  </button>
</template>
