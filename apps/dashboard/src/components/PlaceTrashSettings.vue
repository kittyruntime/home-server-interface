<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { trpc } from '../lib/trpc'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'

// The trash of one place (#200), in its settings: on or off, and whether and
// when old items are emptied.
type Place = { id: string; name: string; trashEnabled?: boolean; trashRetentionDays?: number | null }
const props = defineProps<{ place: Place }>()
const emit = defineEmits<{ changed: [place: Place] }>()
const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirm()

const DEFAULT_DAYS = 30
const enabled = ref(!!props.place.trashEnabled)
const autoEmpty = ref(props.place.trashRetentionDays != null)
const days = ref(props.place.trashRetentionDays ?? DEFAULT_DAYS)
const saving = ref(false)

watch(() => props.place, p => {
  enabled.value = !!p.trashEnabled
  autoEmpty.value = p.trashRetentionDays != null
  days.value = p.trashRetentionDays ?? DEFAULT_DAYS
})

async function save(next: { enabled: boolean; autoEmpty: boolean; days: number }, emptyExisting?: boolean) {
  saving.value = true
  try {
    const retentionDays = next.autoEmpty ? Math.min(3650, Math.max(1, Math.round(next.days || DEFAULT_DAYS))) : null
    const updated = await trpc.place.setTrash.mutate({ id: props.place.id, enabled: next.enabled, retentionDays, emptyExisting })
    emit('changed', updated as Place)
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : String(e))
    enabled.value = !!props.place.trashEnabled
  } finally {
    saving.value = false
  }
}

async function toggle(on: boolean) {
  if (on) return save({ enabled: true, autoEmpty: autoEmpty.value, days: days.value })
  // Turning it off: what is in the trash either goes now or stays until emptied.
  const empty = await confirm(t('files.trash.disableMessage', { name: props.place.name }), {
    title: t('files.trash.disableTitle'),
    confirmLabel: t('files.trash.disableEmpty'),
    cancelLabel: t('files.trash.disableKeep'),
    danger: true,
  })
  return save({ enabled: false, autoEmpty: autoEmpty.value, days: days.value }, empty)
}
</script>

<template>
  <div class="space-y-3 px-4 py-3">
    <label class="flex cursor-pointer items-center justify-between gap-4">
      <span class="space-y-0.5">
        <span class="block text-sm font-medium">{{ t('files.trash.setting') }}</span>
        <span class="block text-xs text-base-content/70">{{ t('files.trash.settingHint') }}</span>
      </span>
      <Switch :model-value="enabled" :disabled="saving" @update:model-value="v => { enabled = v; void toggle(v) }" />
    </label>
    <div v-if="enabled" class="flex flex-wrap items-center gap-2 text-sm">
      <label class="flex cursor-pointer items-center gap-2">
        <Checkbox :model-value="autoEmpty" :disabled="saving"
          @update:model-value="v => { autoEmpty = v === true; void save({ enabled, autoEmpty, days }) }" />
        {{ t('files.trash.autoEmpty') }}
      </label>
      <Input v-model.number="days" type="number" min="1" max="3650" :disabled="!autoEmpty || saving"
        :aria-label="t('files.trash.days')" class="input-sm w-20 tabular-nums"
        @change="save({ enabled, autoEmpty, days })" />
      <span class="text-base-content/70">{{ t('files.trash.daysUnit') }}</span>
    </div>
  </div>
</template>
