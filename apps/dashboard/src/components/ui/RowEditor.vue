<script setup lang="ts" generic="T extends Record<string, any>">
const props = defineProps<{
  modelValue: T[]
  emptyText:  string
  addLabel:   string
  newItem:    () => T
}>()
const emit = defineEmits<{ 'update:modelValue': [v: T[]] }>()

function add()             { emit('update:modelValue', [...props.modelValue, props.newItem()]) }
function remove(i: number) { emit('update:modelValue', props.modelValue.filter((_, idx) => idx !== i)) }
function update(i: number, patch: Partial<T>) {
  emit('update:modelValue', props.modelValue.map((item, idx) => idx === i ? { ...item, ...patch } : item))
}
</script>

<template>
  <div class="space-y-2">
    <div v-if="modelValue.length === 0" class="text-sm text-[var(--c-text-3)] py-2">{{ emptyText }}</div>

    <div v-for="(item, i) in modelValue" :key="i" class="space-y-1">
      <div class="flex items-center gap-2">
        <slot name="row" :item="item" :index="i" :update="(patch: Partial<T>) => update(i, patch)" />
        <button @click="remove(i)" class="p-1.5 text-[var(--c-text-3)] hover:text-[var(--c-danger)] transition-colors shrink-0 cursor-pointer">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <slot name="extra" :item="item" :index="i" :update="(patch: Partial<T>) => update(i, patch)" />
    </div>

    <button @click="add" class="flex items-center gap-1.5 text-sm text-[var(--c-accent)] hover:opacity-80 transition-colors cursor-pointer">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
      </svg>
      {{ addLabel }}
    </button>
  </div>
</template>
