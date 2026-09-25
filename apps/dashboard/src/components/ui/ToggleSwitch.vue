<script setup lang="ts">
// On/off switch. The knob is anchored with left-0.5: without a horizontal
// anchor an absolutely positioned child of a <button> starts from the
// button's centred content, and translate-x-4 pushes it out of the track.
defineProps<{ modelValue: boolean; title?: string }>()
defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :title="title"
    :class="[
      'relative shrink-0 w-9 h-5 rounded-full transition-colors',
      modelValue ? 'bg-[var(--c-accent)]' : 'bg-[var(--c-surface-deep)] border border-[var(--c-border-strong)]',
    ]"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span
      :class="[
        'absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
        modelValue ? 'translate-x-4' : 'translate-x-0',
      ]"
    />
  </button>
</template>
