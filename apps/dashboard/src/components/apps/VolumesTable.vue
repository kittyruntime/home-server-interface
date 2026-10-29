<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import RowEditor from '../ui/RowEditor.vue'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const { t } = useI18n()

export interface VolumeMount { type: 'bind' | 'named' | 'place'; source: string; target: string }
export interface Place        { id: string; name: string; path: string }

const props = defineProps<{
  modelValue: VolumeMount[]
  places:     Place[]
}>()
defineEmits<{ 'update:modelValue': [v: VolumeMount[]] }>()

/** Resolves a place's real filesystem path from its id. */
function placePath(id: string): string | null {
  return props.places.find(p => p.id === id)?.path ?? null
}
</script>

<template>
  <RowEditor
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    :empty-text="t('ui.apps.VolumesTable.noVolumes')"
    add-label="Add volume"
    :new-item="(): VolumeMount => ({ type: 'bind', source: '', target: '' })"
  >
    <template #row="{ item, update }">
      <!-- Type -->
      <NativeSelect wrapper-class="w-auto"
        :model-value="item.type"
        @change="update({ type: ($event.target as HTMLSelectElement).value as VolumeMount['type'], source: '' })"
        class="px-2 py-1.5 text-sm"
      >
        <NativeSelectOption value="bind">{{ t('ui.apps.VolumesTable.bind') }}</NativeSelectOption>
        <NativeSelectOption value="named">{{ t('ui.apps.VolumesTable.named') }}</NativeSelectOption>
        <NativeSelectOption value="place">{{ t('ui.apps.VolumesTable.place') }}</NativeSelectOption>
      </NativeSelect>

      <!-- Source -->
      <!-- bind: free-form host path -->
      <Input
        v-if="item.type === 'bind'"
        :model-value="item.source" laceholder="/host/path"
        @input="update({ source: ($event.target as HTMLInputElement).value })"
        class="flex-1 px-2 py-1.5 text-sm font-mono"
      />
      <!-- named: container volume name -->
      <Input
        v-else-if="item.type === 'named'"
        :model-value="item.source" laceholder="my-volume"
        @input="update({ source: ($event.target as HTMLInputElement).value })"
        class="flex-1 px-2 py-1.5 text-sm font-mono"
      />
      <!-- place: select parmi les Places -->
      <NativeSelect wrapper-class="flex-1"
        v-else
        :model-value="item.source"
        @change="update({ source: ($event.target as HTMLSelectElement).value })"
        class="px-2 py-1.5 text-sm"
      >
        <NativeSelectOption value="">{{ t('ui.apps.VolumesTable.selectAPlace') }}</NativeSelectOption>
        <NativeSelectOption v-for="pl in places" :key="pl.id" :value="pl.id">{{ pl.name }}</NativeSelectOption>
      </NativeSelect>

      <span class="text-muted-foreground text-sm shrink-0">→</span>

      <!-- Target (path inside the container) -->
      <Input
        :model-value="item.target" laceholder="/container/path"
        @input="update({ target: ($event.target as HTMLInputElement).value })"
        class="flex-1 px-2 py-1.5 text-sm font-mono"
      />
    </template>

    <template #extra="{ item }">
      <p
        v-if="item.type === 'place' && item.source && placePath(item.source)"
        class="ml-[calc(theme(spacing.2)+5rem)] text-xs text-muted-foreground font-mono"
      >
        ↳ {{ placePath(item.source) }}
      </p>
    </template>
  </RowEditor>
</template>
