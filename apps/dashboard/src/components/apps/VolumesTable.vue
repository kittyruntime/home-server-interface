<script setup lang="ts">
import RowEditor from '../ui/RowEditor.vue'

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
    empty-text="No volumes."
    add-label="Add volume"
    :new-item="(): VolumeMount => ({ type: 'bind', source: '', target: '' })"
  >
    <template #row="{ item, update }">
      <!-- Type -->
      <select
        :value="item.type"
        @change="update({ type: ($event.target as HTMLSelectElement).value as VolumeMount['type'], source: '' })"
        class="bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      >
        <option value="bind">Bind</option>
        <option value="named">Named</option>
        <option value="place">Place</option>
      </select>

      <!-- Source -->
      <!-- bind: free-form host path -->
      <input
        v-if="item.type === 'bind'"
        :value="item.source" placeholder="/host/path"
        @input="update({ source: ($event.target as HTMLInputElement).value })"
        class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
      <!-- named: container volume name -->
      <input
        v-else-if="item.type === 'named'"
        :value="item.source" placeholder="my-volume"
        @input="update({ source: ($event.target as HTMLInputElement).value })"
        class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
      <!-- place: select parmi les Places -->
      <select
        v-else
        :value="item.source"
        @change="update({ source: ($event.target as HTMLSelectElement).value })"
        class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      >
        <option value="">— select place —</option>
        <option v-for="pl in places" :key="pl.id" :value="pl.id">{{ pl.name }}</option>
      </select>

      <span class="text-[var(--c-text-3)] text-sm shrink-0">→</span>

      <!-- Target (path inside the container) -->
      <input
        :value="item.target" placeholder="/container/path"
        @input="update({ target: ($event.target as HTMLInputElement).value })"
        class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
    </template>

    <template #extra="{ item }">
      <p
        v-if="item.type === 'place' && item.source && placePath(item.source)"
        class="ml-[calc(theme(spacing.2)+5rem)] text-xs text-[var(--c-text-3)] font-mono"
      >
        ↳ {{ placePath(item.source) }}
      </p>
    </template>
  </RowEditor>
</template>
