<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../../../lib/trpc'
import { useConfirm } from '../../../lib/confirm'
import EmptyState from '../../ui/EmptyState.vue'
import LoadingSpinner from '../../ui/LoadingSpinner.vue'

const { confirm } = useConfirm()

type Volume = { id: string; name: string; volumeType: string; sourcePath: string | null; placeId: string | null }

const volumes    = ref<Volume[]>([])
const loading    = ref(true)
const adding     = ref(false)
const addLoading = ref(false)
const addError   = ref('')
const form       = ref({ name: '', volumeType: 'named', sourcePath: '', placeId: '' })

async function load() {
  loading.value = true
  try {
    volumes.value = await trpc.container.volume.list.query() as Volume[]
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function addVolume() {
  addError.value = ''
  addLoading.value = true
  try {
    const { volume } = await trpc.container.volume.create.mutate({
      name:        form.value.name.trim(),
      volumeType:  form.value.volumeType as any,
      sourcePath:  form.value.sourcePath.trim() || null,
      placeId:     form.value.placeId.trim() || null,
    })
    volumes.value.push(volume as Volume)
    form.value = { name: '', volumeType: 'named', sourcePath: '', placeId: '' }
    adding.value = false
  } catch (e: any) {
    addError.value = e?.message ?? 'Failed to create volume'
  } finally {
    addLoading.value = false
  }
}

async function deleteVolume(id: string) {
  if (!await confirm('Remove this volume?', { danger: true, confirmLabel: 'Remove' })) return
  try {
    await trpc.container.volume.delete.mutate({ id })
    volumes.value = volumes.value.filter(v => v.id !== id)
  } catch (e: any) {
    alert(e?.message ?? 'Failed to delete volume')
  }
}

function typeLabel(t: string) {
  return { named: 'Named', path: 'Path', place: 'Place' }[t] ?? t
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Toolbar -->
    <div class="flex items-center justify-between px-6 py-4 border-b border-[var(--c-border)]">
      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">Volumes</h3>
      <button
        @click="adding = !adding"
        class="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--c-accent)] text-[var(--c-accent-fg)] text-sm rounded-lg hover:opacity-90 transition-colors"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
        </svg>
        New Volume
      </button>
    </div>

    <!-- Add form -->
    <div v-if="adding" class="mx-6 my-4 p-4 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-xl space-y-3">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="text-xs text-[var(--c-text-3)]">Name *</label>
          <input v-model="form.name" placeholder="my-data"
            class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]" />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs text-[var(--c-text-3)]">Type</label>
          <select v-model="form.volumeType"
            class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]">
            <option value="named">Named (container-managed)</option>
            <option value="path">Path (host bind)</option>
            <option value="place">Place</option>
          </select>
        </div>
        <div v-if="form.volumeType !== 'named'" class="space-y-1.5 col-span-2">
          <label class="text-xs text-[var(--c-text-3)]">{{ form.volumeType === 'path' ? 'Source path' : 'Place ID' }}</label>
          <input v-model="form.sourcePath" :placeholder="form.volumeType === 'path' ? '/data/myapp' : 'place-uuid'"
            class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]" />
        </div>
      </div>
      <p v-if="addError" class="text-xs text-[var(--c-accent)]">{{ addError }}</p>
      <div class="flex justify-end gap-2">
        <button @click="adding = false" class="px-3 py-1.5 text-sm text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors">Cancel</button>
        <button @click="addVolume" :disabled="addLoading || !form.name"
          class="px-3 py-1.5 text-sm bg-[var(--c-accent)] text-[var(--c-accent-fg)] rounded-lg hover:opacity-90 disabled:opacity-50 transition-colors">
          {{ addLoading ? 'Creating…' : 'Create' }}
        </button>
      </div>
    </div>

    <!-- List -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="loading" class="flex items-center justify-center h-40 text-[var(--c-text-3)] text-sm"><LoadingSpinner /></div>
      <div v-else-if="volumes.length === 0 && !adding" class="flex items-center justify-center h-40">
        <EmptyState message="No volumes yet." />
      </div>
      <div v-else-if="volumes.length > 0" class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-[var(--c-border)]">
            <th class="text-left px-6 py-2.5 text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Name</th>
            <th class="text-left px-3 py-2.5 text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Type</th>
            <th class="text-left px-3 py-2.5 text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Source</th>
            <th class="px-6 py-2.5" />
          </tr>
        </thead>
        <tbody class="divide-y divide-[var(--c-border)]">
          <tr v-for="vol in volumes" :key="vol.id" class="hover:bg-[var(--c-hover)] transition-colors">
            <td class="px-6 py-3 font-mono text-[var(--c-text-1)]">{{ vol.name }}</td>
            <td class="px-3 py-3 text-[var(--c-text-3)]">{{ typeLabel(vol.volumeType) }}</td>
            <td class="px-3 py-3 text-[var(--c-text-3)] font-mono text-xs">{{ vol.sourcePath ?? vol.placeId ?? '—' }}</td>
            <td class="px-6 py-3 text-right">
              <button @click="deleteVolume(vol.id)"
                class="p-1.5 text-[var(--c-text-3)] hover:text-[var(--c-accent)] transition-colors rounded-lg hover:bg-[var(--c-hover)]">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>
</template>
