<script setup lang="ts">
import { ChevronUpIcon } from '@lucide/vue'

defineProps<{ active: boolean; dir: 'asc' | 'desc' }>()
defineEmits<{ click: [] }>()
</script>

<template>
  <button
    class="inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 transition-colors"
    @click="$emit('click')"
  >
    <slot />
    <ChevronUpIcon
      :class="['size-3 shrink-0 transition-transform', active ? 'text-primary' : 'text-muted-foreground opacity-40', active && dir === 'desc' ? 'rotate-180' : '']"
      :stroke-width="2.5"
    />
  </button>
</template>
