<!-- Placeholder — full wizard implemented in Task 6 -->
<script setup lang="ts">
defineProps<{ appId: string }>()
defineEmits<{ installed: []; close: [] }>()
</script>

<template>
  <div class="panel-card p-4">
    <p class="text-sm text-[var(--c-text-1)]">
      Install wizard for <span class="font-medium">{{ appId }}</span> is coming soon.
    </p>
    <div class="flex items-center gap-2 mt-3">
      <button class="btn btn-outline btn-sm" @click="$emit('close')">Back</button>
      <button class="btn btn-primary btn-sm" disabled title="Coming soon">Install (coming soon)</button>
    </div>
  </div>
</template>
