<script setup lang="ts">
import { computed } from 'vue'
import { toneOf, type Tone } from './tone'

// A fill bar from 0 to 100. The color follows the level (or `tone`), and the
// figure next to it always says the same thing in words.
const props = defineProps<{ value: number; tone?: Tone; warn?: number; bad?: number; label?: string }>()
const tone = computed(() => props.tone ?? toneOf(props.value, props.warn, props.bad))
const FILL: Record<Tone, string> = { ok: 'bg-success', warn: 'bg-warning', bad: 'bg-error', neutral: 'bg-base-content/40' }
</script>

<template>
  <div class="h-1.5 w-full overflow-hidden rounded-full bg-base-300" role="meter" :aria-valuenow="Math.round(value)" aria-valuemin="0" aria-valuemax="100" :aria-label="label">
    <div :class="['h-full rounded-full transition-[width] duration-[var(--dur-base)]', FILL[tone]]" :style="{ width: `${Math.max(0, Math.min(100, value))}%` }" />
  </div>
</template>
