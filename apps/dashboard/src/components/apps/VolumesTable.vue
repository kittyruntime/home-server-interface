<script setup lang="ts">

export interface VolumeMount { type: 'bind' | 'named' | 'place'; source: string; target: string }
export interface Place        { id: string; name: string; path: string }

const props = defineProps<{
  modelValue: VolumeMount[]
  places:     Place[]
}>()
const emit = defineEmits<{ 'update:modelValue': [v: VolumeMount[]] }>()

/** Retrouve le chemin réel d'un place à partir de son id. */
function placePath(id: string): string | null {
  return props.places.find(p => p.id === id)?.path ?? null
}

function add()             { emit('update:modelValue', [...props.modelValue, { type: 'bind', source: '', target: '' }]) }
function remove(i: number) { emit('update:modelValue', props.modelValue.filter((_, idx) => idx !== i)) }
function update(i: number, field: keyof VolumeMount, val: string) {
  const copy = props.modelValue.map((v, idx) =>
    idx === i ? { ...v, [field]: val, ...(field === 'type' ? { source: '' } : {}) } : v
  )
  emit('update:modelValue', copy)
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="modelValue.length === 0" class="text-sm text-[var(--c-text-3)] py-2">No volumes.</div>

    <div v-for="(vol, i) in modelValue" :key="i" class="space-y-1">
      <div class="flex items-center gap-2">
        <!-- Type -->
        <select
          :value="vol.type"
          @change="update(i, 'type', ($event.target as HTMLSelectElement).value)"
          class="bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        >
          <option value="bind">Bind</option>
          <option value="named">Named</option>
          <option value="place">Place</option>
        </select>

        <!-- Source -->
        <!-- bind: chemin hôte libre -->
        <input
          v-if="vol.type === 'bind'"
          :value="vol.source" placeholder="/host/path"
          @input="update(i, 'source', ($event.target as HTMLInputElement).value)"
          class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
        <!-- named: nom du volume container -->
        <input
          v-else-if="vol.type === 'named'"
          :value="vol.source" placeholder="my-volume"
          @input="update(i, 'source', ($event.target as HTMLInputElement).value)"
          class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
        <!-- place: select parmi les Places -->
        <select
          v-else
          :value="vol.source"
          @change="update(i, 'source', ($event.target as HTMLSelectElement).value)"
          class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        >
          <option value="">— select place —</option>
          <option v-for="pl in places" :key="pl.id" :value="pl.id">{{ pl.name }}</option>
        </select>

        <span class="text-[var(--c-text-3)] text-sm shrink-0">→</span>

        <!-- Target (chemin dans le container) -->
        <input
          :value="vol.target" placeholder="/container/path"
          @input="update(i, 'target', ($event.target as HTMLInputElement).value)"
          class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />

        <button @click="remove(i)" class="p-1.5 text-[var(--c-text-3)] hover:text-red-400 transition-colors shrink-0">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Chemin résolu pour les Places -->
      <p
        v-if="vol.type === 'place' && vol.source && placePath(vol.source)"
        class="ml-[calc(theme(spacing.2)+5rem)] text-xs text-[var(--c-text-3)] font-mono"
      >
        ↳ {{ placePath(vol.source) }}
      </p>
    </div>

    <button
      @click="add"
      class="flex items-center gap-1.5 text-sm text-[var(--c-accent)] hover:opacity-80 transition-colors"
    >
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
      </svg>
      Add volume
    </button>
  </div>
</template>
