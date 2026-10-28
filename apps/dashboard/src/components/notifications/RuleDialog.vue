<script setup lang="ts">
import { Checkbox } from '@/components/ui/checkbox'
import { ref, computed } from 'vue'
import { trpc } from '../../lib/trpc'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

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
      <h3 class="text-sm font-semibold text-foreground">
        {{ rule ? 'Edit rule' : 'Add rule' }}
      </h3>
    </template>

    <div class="p-5 space-y-4">
      <div class="space-y-1.5">
        <label class="block text-xs text-muted-foreground">Name</label>
        <Input v-model="name" placeholder="All alerts" />
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-muted-foreground">Source prefix</label>
        <Input v-model="sourcePrefix" placeholder="empty = all sources, e.g. storage." class="font-mono" />
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-muted-foreground">Min severity</label>
        <NativeSelect v-model="minSeverity">
          <NativeSelectOption value="info">Info</NativeSelectOption>
          <NativeSelectOption value="warning">Warning</NativeSelectOption>
          <NativeSelectOption value="critical">Critical</NativeSelectOption>
        </NativeSelect>
        <p class="text-xs text-muted-foreground">Events below this severity are ignored.</p>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-muted-foreground">Targets</label>
        <label
          v-for="opt in options" :key="opt.id"
          class="flex items-center gap-2 text-sm text-foreground/80 cursor-pointer"
        >
          <Checkbox :model-value="selectedIds.includes(opt.id)" @update:model-value="checked => selectedIds = checked === true ? [...selectedIds, opt.id] : selectedIds.filter(id => id !== opt.id)" />
          {{ opt.name }}
        </label>
        <p v-if="selectedIds.length === 0" class="text-xs text-destructive">Pick at least one target.</p>
      </div>

      <label class="flex items-center gap-2 text-sm text-foreground/80 cursor-pointer">
        <Checkbox v-model="enabled" />
        Enabled
      </label>

      <p v-if="saveError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ saveError }}</p>
    </div>

    <template #footer>
      <div class="flex-1" />
      <Button variant="ghost" size="sm" type="button" @click="emit('close')">Cancel</Button>
      <Button size="sm"
        type="button"
        :disabled="saving || !name.trim() || selectedIds.length === 0"
        @click="save"
      >
        {{ saving ? 'Saving…' : 'Save' }}
      </Button>
    </template>
  </Modal>
</template>
