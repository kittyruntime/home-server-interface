<script setup lang="ts">
import { CircleAlertIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{ message: string; compact?: boolean; retryLabel?: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div role="alert" :class="['flex flex-col items-center text-center', compact ? 'gap-2 py-4' : 'gap-3 py-12']">
    <span class="grid size-9 place-items-center rounded-full bg-destructive/10 text-destructive" aria-hidden="true">
      <CircleAlertIcon class="size-5" />
    </span>
    <p class="max-w-md break-words text-sm text-destructive">{{ message }}</p>
    <Button v-if="retryLabel" variant="outline" size="sm" @click="$emit('retry')">{{ retryLabel }}</Button>
  </div>
</template>
