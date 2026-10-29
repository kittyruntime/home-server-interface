<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import RowEditor from '../ui/RowEditor.vue'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

export interface LabelEntry { key: string; value: string }

defineProps<{ modelValue: LabelEntry[] }>()
defineEmits<{ 'update:modelValue': [v: LabelEntry[]] }>()
</script>

<template>
  <RowEditor
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    :empty-text="t('ui.apps.LabelsTable.noLabels')"
    add-label="Add label"
    :new-item="() => ({ key: '', value: '' })"
  >
    <template #row="{ item, update }">
      <Input
        :model-value="item.key" laceholder="label.key"
        @input="update({ key: ($event.target as HTMLInputElement).value })"
        class="flex-1 px-2 py-1.5 text-sm font-mono"
      />
      <span class="text-muted-foreground text-sm">=</span>
      <Input
        :model-value="item.value" laceholder="value"
        @input="update({ value: ($event.target as HTMLInputElement).value })"
        class="flex-1 px-2 py-1.5 text-sm font-mono"
      />
    </template>
  </RowEditor>
</template>
