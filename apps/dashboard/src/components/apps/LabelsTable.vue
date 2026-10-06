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
        class="ui-input flex-1 px-2 py-1.5 text-sm font-mono"
      />
      <span class="text-[var(--c-text-3)] text-sm">=</span>
      <input
        :value="item.value" placeholder="value"
        @input="update({ value: ($event.target as HTMLInputElement).value })"
        class="ui-input flex-1 px-2 py-1.5 text-sm font-mono"
      />
    </template>
  </RowEditor>
</template>
