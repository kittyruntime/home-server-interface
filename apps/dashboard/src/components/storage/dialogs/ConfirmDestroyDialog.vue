<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert } from '@/components/ui/alert'
import { TriangleAlertIcon } from '@lucide/vue'
import { ref, computed } from 'vue'
import Modal from '../../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

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
    <div class="px-5 py-4 border-b border-border bg-destructive/5">
      <h3 class="font-semibold text-destructive">{{ title }}</h3>
      <p v-if="subtitle" class="text-xs text-muted-foreground mt-0.5">{{ subtitle }}</p>
    </div>
    <div class="p-5 space-y-4">
      <Alert variant="destructive" class="flex items-start gap-2 p-3 text-xs" role="note">
        <TriangleAlertIcon class="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
        <span><slot name="warning" /></span>
      </Alert>
      <div class="space-y-1 text-xs text-muted-foreground">
        <slot name="details" />
      </div>
      <div v-if="confirmWord != null">
        <label class="block text-xs text-foreground/80 mb-1.5">
          {{ t('ui.storage.ConfirmDestroyDialog.type') }} <span class="font-mono font-bold text-foreground">{{ confirmWord }}</span> {{ t('ui.storage.ConfirmDestroyDialog.toConfirm') }}
        </label>
        <Input v-model="typed" type="text" :placeholder="confirmWord"
          class="w-full px-3 py-2 text-sm font-mono placeholder-muted-foreground"/>
      </div>
      <p v-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
      <div class="flex gap-2">
        <Button variant="outline" @click="emit('close')" class="flex-1 justify-center">{{ t('ui.storage.ConfirmDestroyDialog.cancel') }}</Button>
        <Button variant="destructive" @click="emit('confirm')" :disabled="!canConfirm"
          class="flex-1 justify-center">
          <span v-if="busy">{{ busyLabel }}</span>
          <span v-else>{{ actionLabel }}</span>
        </Button>
      </div>
    </div>
  </Modal>
</template>
