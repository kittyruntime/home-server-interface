<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { trpc } from '../../lib/trpc'

// The admin's name for a physical disk ("bay 3, top"), stored by serial so it
// follows the disk when its kernel name changes (#32). Edited in place.
const props = defineProps<{ serial?: string; label: string }>()
const emit  = defineEmits<{ saved: [label: string] }>()

const editing = ref(false)
const draft   = ref('')
const saving  = ref(false)
const error   = ref('')
const input   = ref<HTMLInputElement | null>(null)

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
      <input
        ref="input" v-model="draft" maxlength="40" :disabled="saving"
        aria-label="Disk label" placeholder="e.g. bay 3, top"
        class="ui-input w-full py-0.5! px-1.5! text-2xs!"
        @keydown.enter.prevent="save" @keydown.esc.prevent="editing = false" @blur="save"
      />
      <span v-if="error" role="alert" class="status-text block text-2xs text-danger">{{ error }}</span>
    </template>
    <button
      v-else-if="serial"
      type="button"
      :class="['max-w-full truncate text-left text-2xs rounded-sm hover:text-[var(--c-text-1)] focus-visible:text-[var(--c-text-1)]',
        label ? 'text-[var(--c-text-2)]' : 'text-[var(--c-text-3)] sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100']"
      :title="label ? 'Rename this disk' : 'Name this disk, for example by its bay'"
      @click="start"
    >{{ label || 'Add label' }}</button>
  </span>
</template>
