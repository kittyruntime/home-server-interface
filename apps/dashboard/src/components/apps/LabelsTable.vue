<script setup lang="ts">
import RowEditor from '../ui/RowEditor.vue'

export interface LabelEntry { key: string; value: string }

defineProps<{ modelValue: LabelEntry[] }>()
defineEmits<{ 'update:modelValue': [v: LabelEntry[]] }>()
</script>

<template>
  <RowEditor
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    empty-text="No labels."
    add-label="Add label"
    :new-item="() => ({ key: '', value: '' })"
  >
    <template #row="{ item, update }">
      <input
        :value="item.key" placeholder="label.key"
        @input="update({ key: ($event.target as HTMLInputElement).value })"
        class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
      <span class="text-[var(--c-text-3)] text-sm">=</span>
      <input
        :value="item.value" placeholder="value"
        @input="update({ value: ($event.target as HTMLInputElement).value })"
        class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
    </template>
  </RowEditor>
</template>
