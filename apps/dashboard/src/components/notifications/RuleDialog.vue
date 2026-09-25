<script setup lang="ts">
import { ref, computed } from 'vue'
import { trpc } from '../../lib/trpc'
import Modal from '../ui/Modal.vue'

const props = defineProps<{
  rule: null | { id: string; name: string; sourcePrefix: string; minSeverity: string; connectorIds: string; enabled: boolean }
  connectors: Array<{ id: string; name: string }>
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const name = ref('')
const sourcePrefix = ref('')
const minSeverity = ref('warning')
const selectedIds = ref<string[]>([])
const enabled = ref(true)

const saving = ref(false)
const saveError = ref('')

name.value = props.rule?.name ?? ''
sourcePrefix.value = props.rule?.sourcePrefix ?? ''
minSeverity.value = props.rule?.minSeverity ?? 'warning'
enabled.value = props.rule?.enabled ?? true

try {
  const parsed = JSON.parse(props.rule?.connectorIds ?? '[]') as unknown
  if (Array.isArray(parsed)) selectedIds.value = parsed.filter((x): x is string => typeof x === 'string')
} catch {
  selectedIds.value = []
}

const options = computed(() => [{ id: 'inapp', name: 'In-app (bell)' }, ...props.connectors])

async function save() {
  if (saving.value) return
  saving.value = true
  saveError.value = ''
  const payload = {
    name: name.value.trim(),
    sourcePrefix: sourcePrefix.value,
    minSeverity: minSeverity.value as 'info' | 'warning' | 'critical',
    connectorIds: selectedIds.value,
    enabled: enabled.value,
  }
  try {
    if (props.rule) {
      await trpc.notifications.rules.update.mutate({ id: props.rule.id, ...payload })
    } else {
      await trpc.notifications.rules.create.mutate(payload)
    }
    emit('saved')
  } catch (e: any) {
    saveError.value = e?.message ?? 'Failed to save rule'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal panel-class="w-full max-w-sm" @close="emit('close')">
    <template #header>
      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">
        {{ rule ? 'Edit rule' : 'Add rule' }}
      </h3>
    </template>

    <div class="p-5 space-y-4">
      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Name</label>
        <input v-model="name" placeholder="All alerts" class="ui-input" />
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Source prefix</label>
        <input v-model="sourcePrefix" placeholder="empty = all sources, e.g. storage." class="ui-input font-mono" />
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Min severity</label>
        <select v-model="minSeverity" class="ui-input">
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
        <p class="text-xs text-[var(--c-text-3)]">Events below this severity are ignored.</p>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Targets</label>
        <label
          v-for="opt in options" :key="opt.id"
          class="flex items-center gap-2 text-sm text-[var(--c-text-2)] cursor-pointer"
        >
          <input v-model="selectedIds" type="checkbox" :value="opt.id" />
          {{ opt.name }}
        </label>
        <p v-if="selectedIds.length === 0" class="text-xs text-[var(--c-danger)]">Pick at least one target.</p>
      </div>

      <label class="flex items-center gap-2 text-sm text-[var(--c-text-2)] cursor-pointer">
        <input v-model="enabled" type="checkbox" />
        Enabled
      </label>

      <p v-if="saveError" class="text-xs text-[var(--c-danger)]">{{ saveError }}</p>
    </div>

    <template #footer>
      <div class="flex-1" />
      <button type="button" class="btn btn-ghost btn-sm" @click="emit('close')">Cancel</button>
      <button
        type="button" class="btn btn-primary btn-sm"
        :disabled="saving || !name.trim() || selectedIds.length === 0"
        @click="save"
      >
        {{ saving ? 'Saving…' : 'Save' }}
      </button>
    </template>
  </Modal>
</template>
