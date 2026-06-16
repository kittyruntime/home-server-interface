<script setup lang="ts">
export interface LabelEntry { key: string; value: string }

const props = defineProps<{ modelValue: LabelEntry[] }>()
const emit  = defineEmits<{ 'update:modelValue': [v: LabelEntry[]] }>()

function add()                { emit('update:modelValue', [...props.modelValue, { key: '', value: '' }]) }
function remove(i: number)    { emit('update:modelValue', props.modelValue.filter((_, idx) => idx !== i)) }
function update(i: number, field: 'key' | 'value', val: string) {
  emit('update:modelValue', props.modelValue.map((e, idx) => idx === i ? { ...e, [field]: val } : e))
}
</script>

<template>
  <div class="space-y-2">
    <div v-if="modelValue.length === 0" class="text-sm text-[var(--c-text-3)] py-2">No labels.</div>
    <div v-for="(lbl, i) in modelValue" :key="i" class="flex items-center gap-2">
      <input
        :value="lbl.key" placeholder="label.key"
        @input="update(i, 'key', ($event.target as HTMLInputElement).value)"
        class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
      <span class="text-[var(--c-text-3)] text-sm">=</span>
      <input
        :value="lbl.value" placeholder="value"
        @input="update(i, 'value', ($event.target as HTMLInputElement).value)"
        class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
      <button @click="remove(i)" class="p-1.5 text-[var(--c-text-3)] hover:text-red-400 transition-colors">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <button
      @click="add"
      class="flex items-center gap-1.5 text-sm text-[var(--c-accent)] hover:opacity-80 transition-colors"
    >
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
      </svg>
      Add label
    </button>
  </div>
</template>
