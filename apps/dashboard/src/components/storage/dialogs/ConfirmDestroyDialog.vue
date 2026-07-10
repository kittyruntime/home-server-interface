<script setup lang="ts">
import { ref, computed } from 'vue'
import Modal from '../../ui/Modal.vue'

/* Shared skeleton for the destructive storage confirmations (remove LV/VG,
   destroy RAID, init partition table, delete partition). The parent renders it
   with v-if and its own busy/error state; this owns the "type NAME to confirm"
   gate (when `confirmWord` is set) and emits `confirm` / `close`. */
const props = defineProps<{
  title: string
  subtitle?: string
  /** When set, the action stays disabled until the user types it exactly. */
  confirmWord?: string
  actionLabel: string
  busyLabel: string
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ confirm: []; close: [] }>()

const typed = ref('')
const canConfirm = computed(() =>
  !props.busy && (props.confirmWord == null || typed.value === props.confirmWord),
)
</script>

<template>
  <Modal panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!busy" @close="emit('close')">
    <div class="px-5 py-4 border-b border-[var(--c-border)] bg-danger/5">
      <h3 class="font-semibold text-danger">{{ title }}</h3>
      <p v-if="subtitle" class="text-xs text-[var(--c-text-3)] mt-0.5">{{ subtitle }}</p>
    </div>
    <div class="p-5 space-y-4">
      <div class="flex items-start gap-2 p-3 rounded-lg bg-danger/10 border border-danger/20 text-xs text-danger">
        <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
        </svg>
        <span><slot name="warning" /></span>
      </div>
      <div class="space-y-1 text-xs text-[var(--c-text-3)]">
        <slot name="details" />
      </div>
      <div v-if="confirmWord != null">
        <label class="block text-xs text-[var(--c-text-2)] mb-1.5">
          Type <span class="font-mono font-bold text-[var(--c-text-1)]">{{ confirmWord }}</span> to confirm
        </label>
        <input v-model="typed" type="text" :placeholder="confirmWord"
          class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-danger transition-colors"/>
      </div>
      <div v-if="error" class="text-xs text-danger">{{ error }}</div>
      <div class="flex gap-2">
        <button @click="emit('close')" class="btn btn-outline flex-1 justify-center">Cancel</button>
        <button @click="emit('confirm')" :disabled="!canConfirm"
          class="btn btn-danger flex-1 justify-center">
          <span v-if="busy">{{ busyLabel }}</span>
          <span v-else>{{ actionLabel }}</span>
        </button>
      </div>
    </div>
  </Modal>
</template>
