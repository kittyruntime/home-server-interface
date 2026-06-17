<script setup lang="ts">
withDefaults(defineProps<{ modelValue: string; placeholder?: string }>(), {
  placeholder: 'Search…',
})
defineEmits<{ 'update:modelValue': [v: string] }>()
</script>

<template>
  <div class="relative">
    <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--c-text-3)] pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/>
    </svg>
    <input
      :value="modelValue"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      :placeholder="placeholder"
      class="ui-input pl-8 pr-8"
    />
    <button
      v-if="modelValue"
      @click="$emit('update:modelValue', '')"
      title="Clear"
      class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors"
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </button>
  </div>
</template>
