<script setup lang="ts">
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

defineProps<{ message: string; description?: string }>()
</script>

<template>
  <Empty role="status" class="gap-4 p-6 md:p-8">
    <EmptyHeader>
      <EmptyMedia v-if="$slots.icon" variant="icon">
        <slot name="icon" />
      </EmptyMedia>
      <EmptyTitle class="text-sm">{{ message }}</EmptyTitle>
      <EmptyDescription v-if="description" class="text-xs">{{ description }}</EmptyDescription>
    </EmptyHeader>
    <EmptyContent v-if="$slots.action">
      <slot name="action" />
    </EmptyContent>
  </Empty>
</template>
