<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ref, nextTick } from 'vue'
import { trpc } from '../../lib/trpc'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

// The admin's name for a physical disk ("bay 3, top"), stored by serial so it
// follows the disk when its kernel name changes (#32). Edited in place.
const props = defineProps<{ serial?: string; label: string }>()
const emit  = defineEmits<{ saved: [label: string] }>()

const editing = ref(false)
const draft   = ref('')
const saving  = ref(false)
const error   = ref('')
const input   = ref<InstanceType<typeof Input> | null>(null)

async function start() {
  if (!props.serial) return
  draft.value = props.label
  error.value = ''
  editing.value = true
  await nextTick()
  input.value?.select()
}

async function save() {
  if (!props.serial || saving.value) return
  if (draft.value.trim() === props.label) { editing.value = false; return }
  saving.value = true
  error.value = ''
  try {
    const res = await trpc.storage.diskLabels.set.mutate({ serial: props.serial, label: draft.value })
    emit('saved', res.label ?? '')
    editing.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not save the label'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <span class="block min-w-0" @click.stop>
    <template v-if="editing">
      <Input
        ref="input" v-model="draft" maxlength="40" :disabled="saving"
        :aria-label="t('ui.storage.DiskLabel.diskLabel')" :placeholder="t('ui.storage.DiskLabel.eGBay3Top')"
        class="w-full py-0.5! px-1.5! text-2xs!"
        @keydown.enter.prevent="save" @keydown.esc.prevent="editing = false" @blur="save"
      />
      <span v-if="error" role="alert" class="status-text block text-2xs text-error">{{ error }}</span>
    </template>
    <Button
      v-else-if="serial"
      type="button"
      variant="ghost"
      :class="['h-auto max-w-full justify-start truncate p-0 text-left text-2xs font-normal rounded-sm hover:bg-transparent hover:text-base-content focus-visible:text-base-content',
        label ? 'text-base-content/80' : 'text-base-content/70 @2xl:opacity-0 @2xl:group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100']"
      :tooltip="label ? t('ui.storage.DiskLabel.renameDisk') : t('ui.storage.DiskLabel.nameDisk')"
      @click="start"
    >{{ label || t('ui.storage.DiskLabel.addLabel') }}</Button>
  </span>
</template>
