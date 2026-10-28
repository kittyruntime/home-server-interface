<script setup lang="ts">
import { Button } from '@/components/ui/button'
defineProps<{ message: string; compact?: boolean; retryLabel?: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div role="alert" :class="['flex flex-col items-center text-center', compact ? 'gap-2 py-4' : 'gap-3 py-12']">
    <span class="grid h-9 w-9 place-items-center rounded-full bg-destructive/10 text-destructive" aria-hidden="true">!</span>
    <p class="max-w-md break-words text-sm text-destructive">{{ message }}</p>
    <Button variant="outline" size="sm" v-if="retryLabel" @click="$emit('retry')">{{ retryLabel }}</Button>
  </div>
</template>
