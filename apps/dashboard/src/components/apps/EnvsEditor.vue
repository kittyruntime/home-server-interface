<script setup lang="ts">
import { ref, watch } from 'vue'

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

function addRow()            { emit('update:modelValue', [...props.modelValue, { key: '', value: '' }]) }
function removeRow(i: number) { emit('update:modelValue', props.modelValue.filter((_, idx) => idx !== i)) }
function updateRow(i: number, field: 'key' | 'value', val: string) {
  emit('update:modelValue', props.modelValue.map((e, idx) => idx === i ? { ...e, [field]: val } : e))
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex justify-end">
      <button
        @click="toggleMode"
        class="text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors border border-[var(--c-border-strong)] rounded-lg px-2 py-1"
      >
        {{ mode === 'table' ? 'Raw' : 'Table' }}
      </button>
    </div>

    <!-- Table mode -->
    <template v-if="mode === 'table'">
      <div v-if="modelValue.length === 0" class="text-sm text-[var(--c-text-3)] py-2">No environment variables.</div>
      <div v-for="(env, i) in modelValue" :key="i" class="flex items-center gap-2">
        <input
          :value="env.key" placeholder="KEY"
          @input="updateRow(i, 'key', ($event.target as HTMLInputElement).value)"
          class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
        <span class="text-[var(--c-text-3)] text-sm">=</span>
        <input
          :value="env.value" placeholder="value"
          @input="updateRow(i, 'value', ($event.target as HTMLInputElement).value)"
          class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
        <button @click="removeRow(i)" class="p-1.5 text-[var(--c-text-3)] hover:text-red-400 transition-colors">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <button
        @click="addRow"
        class="flex items-center gap-1.5 text-sm text-[var(--c-accent)] hover:opacity-80 transition-colors"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
        </svg>
        Add variable
      </button>
    </template>

    <!-- Raw mode -->
    <template v-else>
      <textarea
        v-model="rawText"
        placeholder="KEY=value&#10;OTHER=foo"
        rows="8"
        class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-3 py-2 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)] resize-y"
      />
    </template>
  </div>
</template>
