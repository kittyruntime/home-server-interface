<script setup lang="ts">
import type { Component } from 'vue'
// What a widget says when there is nothing to show yet, or nothing at all.
defineProps<{ icon?: Component; text: string; tone?: 'ok' | 'neutral' }>()
</script>

<template>
  <div class="flex flex-1 flex-col items-start justify-center gap-1.5 py-2 text-sm text-base-content/70">
    <component :is="icon" v-if="icon" :class="['size-5', tone === 'ok' ? 'text-success' : 'text-base-content/40']" aria-hidden="true" />
    <p>{{ text }}</p>
    <slot />
  </div>
</template>
