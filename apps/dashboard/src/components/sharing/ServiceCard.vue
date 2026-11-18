<script setup lang="ts">
import type { Component } from 'vue'
import { Card } from '@/components/ui/card'

// One file service: what it is, whether it runs, and its settings below.
export type ServiceState = 'on' | 'off' | 'missing' | 'checking'

defineProps<{
  icon: Component
  title: string
  /** What clients it serves, one line. */
  summary: string
  state: ServiceState
  stateLabel: string
}>()
</script>

<template>
  <Card class="gap-0 overflow-hidden py-0">
    <header class="flex flex-wrap items-center gap-x-4 gap-y-3 p-4 @2xl:px-5">
      <span class="flex size-9 shrink-0 items-center justify-center rounded-field bg-base-200 text-base-content/80">
        <component :is="icon" class="size-4.5" aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1 basis-48">
        <h3 class="text-sm font-semibold text-base-content">{{ title }}</h3>
        <p class="text-xs text-base-content/70">{{ summary }}</p>
      </div>
      <p class="flex shrink-0 items-center gap-2 text-xs font-medium" role="status"
        :class="state === 'on' ? 'text-success' : state === 'off' ? 'text-warning' : 'text-base-content/70'">
        <span class="size-2 shrink-0 rounded-full" aria-hidden="true" :class="{
          'bg-success': state === 'on',
          'bg-warning': state === 'off',
          'bg-base-content/30': state === 'missing',
          'animate-pulse bg-base-content/30': state === 'checking',
        }" />
        {{ stateLabel }}
      </p>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2"><slot name="actions" /></div>
    </header>
    <div v-if="$slots.default" class="space-y-5 border-t border-base-300 p-4 @2xl:p-5"><slot /></div>
  </Card>
</template>
