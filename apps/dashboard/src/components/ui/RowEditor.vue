<script setup lang="ts" generic="T extends Record<string, any>">
import { PlusIcon, XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'

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
    <div v-if="modelValue.length === 0" class="text-sm text-muted-foreground py-2">{{ emptyText }}</div>

    <div v-for="(item, i) in modelValue" :key="i" class="space-y-1">
      <div class="flex items-center gap-2">
        <slot name="row" :item="item" :index="i" :update="(patch: Partial<T>) => update(i, patch)" />
        <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Remove" @click="remove(i)">
          <XIcon />
        </Button>
      </div>
      <slot name="extra" :item="item" :index="i" :update="(patch: Partial<T>) => update(i, patch)" />
    </div>

    <Button variant="ghost" size="sm" class="-ml-2 text-primary hover:text-primary" @click="add">
      <PlusIcon />
      {{ addLabel }}
    </Button>
  </div>
</template>
