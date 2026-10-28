<script setup lang="ts">
defineProps<{ message: string; description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center text-center py-8" role="status">
    <slot name="icon" />
    <p class="text-sm font-semibold text-foreground/80 mt-3">{{ message }}</p>
    <p v-if="description" class="text-xs text-muted-foreground max-w-xs mt-1">{{ description }}</p>
    <div v-if="$slots.action" class="mt-4">
      <slot name="action" />
    </div>
  </div>
</template>
