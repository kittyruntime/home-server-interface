<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ref, watch } from 'vue'
import { parseContainerEnv, serializeContainerEnv } from '../../lib/container-env'
import RowEditor from '../ui/RowEditor.vue'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const { t } = useI18n()

export interface EnvVar { key: string; value: string }

const props = defineProps<{ modelValue: EnvVar[] }>()
const emit  = defineEmits<{ 'update:modelValue': [v: EnvVar[]] }>()

const mode    = ref<'table' | 'raw'>('table')
const rawText = ref('')

function syncToRaw() {
  rawText.value = serializeContainerEnv(props.modelValue)
}
function syncFromRaw() {
  emit('update:modelValue', parseContainerEnv(rawText.value))
}
function updateRaw(value: string | number) {
  rawText.value = String(value)
  syncFromRaw()
}

function toggleMode() {
  if (mode.value === 'table') {
    syncToRaw()
    mode.value = 'raw'
  } else {
    syncFromRaw()
    mode.value = 'table'
  }
}

watch(() => props.modelValue, () => {
  // Keep incomplete lines while typing; only replace the draft on an external change.
  if (mode.value === 'raw' && JSON.stringify(parseContainerEnv(rawText.value)) !== JSON.stringify(props.modelValue)) syncToRaw()
}, { deep: true })
</script>

<template>
  <div class="space-y-2">
    <div class="flex justify-end">
      <Button variant="outline" size="xs"
        @click="toggleMode"
        class="text-base-content/70 hover:text-base-content"
      >
        {{ mode === 'table' ? 'Raw' : 'Table' }}
      </Button>
    </div>

    <!-- Table mode -->
    <template v-if="mode === 'table'">
      <RowEditor
        :model-value="modelValue"
        @update:model-value="emit('update:modelValue', $event)"
        :empty-text="t('ui.apps.EnvsEditor.noEnvironmentVariables')"
        add-label="Add variable"
        :new-item="() => ({ key: '', value: '' })"
      >
        <template #row="{ item, update }">
          <Input
            :model-value="item.key" placeholder="KEY" aria-label="Variable name"
            @input="update({ key: ($event.target as HTMLInputElement).value })"
            class="flex-1 px-2 py-1.5 text-sm font-mono"
          />
          <span class="text-base-content/70 text-sm">=</span>
          <Input
            :model-value="item.value" placeholder="value" aria-label="Variable value"
            @input="update({ value: ($event.target as HTMLInputElement).value })"
            class="flex-1 px-2 py-1.5 text-sm font-mono"
          />
        </template>
      </RowEditor>
    </template>

    <!-- Raw mode -->
    <template v-else>
      <Textarea
        :model-value="rawText"
        @update:model-value="updateRaw"
        :placeholder="t('ui.apps.EnvsEditor.keyValue10OtherFoo')"
        rows="8"
        class="w-full px-3 py-2 text-sm font-mono resize-y"
      />
    </template>
  </div>
</template>
