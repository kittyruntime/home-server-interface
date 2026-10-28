<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { ref, watch } from 'vue'
import RowEditor from '../ui/RowEditor.vue'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export interface EnvVar { key: string; value: string }

const props = defineProps<{ modelValue: EnvVar[] }>()
const emit  = defineEmits<{ 'update:modelValue': [v: EnvVar[]] }>()

const mode    = ref<'table' | 'raw'>('table')
const rawText = ref('')

function syncToRaw() {
  rawText.value = props.modelValue.filter(e => e.key).map(e => `${e.key}=${e.value}`).join('\n')
}
function syncFromRaw() {
  const parsed = rawText.value
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => ({ key: l.slice(0, l.indexOf('=')).trim(), value: l.slice(l.indexOf('=') + 1) }))
    .filter(e => e.key)
  emit('update:modelValue', parsed)
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
  if (mode.value === 'raw') syncToRaw()
}, { deep: true })
</script>

<template>
  <div class="space-y-2">
    <div class="flex justify-end">
      <Button variant="outline" size="xs"
        @click="toggleMode"
        class="text-muted-foreground hover:text-foreground"
      >
        {{ mode === 'table' ? 'Raw' : 'Table' }}
      </Button>
    </div>

    <!-- Table mode -->
    <template v-if="mode === 'table'">
      <RowEditor
        :model-value="modelValue"
        @update:model-value="emit('update:modelValue', $event)"
        empty-text="No environment variables."
        add-label="Add variable"
        :new-item="() => ({ key: '', value: '' })"
      >
        <template #row="{ item, update }">
          <Input
            :model-value="item.key" placeholder="KEY"
            @input="update({ key: ($event.target as HTMLInputElement).value })"
            class="flex-1 px-2 py-1.5 text-sm font-mono"
          />
          <span class="text-muted-foreground text-sm">=</span>
          <Input
            :model-value="item.value" placeholder="value"
            @input="update({ value: ($event.target as HTMLInputElement).value })"
            class="flex-1 px-2 py-1.5 text-sm font-mono"
          />
        </template>
      </RowEditor>
    </template>

    <!-- Raw mode -->
    <template v-else>
      <Textarea
        v-model="rawText"
        placeholder="KEY=value&#10;OTHER=foo"
        rows="8"
        class="w-full px-3 py-2 text-sm font-mono resize-y"
      />
    </template>
  </div>
</template>
