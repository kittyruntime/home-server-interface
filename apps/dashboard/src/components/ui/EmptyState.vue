<script setup lang="ts">
defineProps<{ message: string; description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center text-center">
    <slot name="icon" />
    <p class="text-sm font-semibold text-[var(--c-text-2)] mt-3">{{ message }}</p>
    <p v-if="description" class="text-xs text-[var(--c-text-3)] max-w-xs mt-1">{{ description }}</p>
    <div v-if="$slots.action" class="mt-4">
      <slot name="action" />
    </div>
  </div>
</template>
