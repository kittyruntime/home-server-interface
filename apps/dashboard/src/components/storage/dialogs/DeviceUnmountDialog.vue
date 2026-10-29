<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { applyPlanned } from '../../../lib/plan'
import { ref } from 'vue'
import { type BlockDev } from '../store'
import Modal from '../../ui/Modal.vue'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

/* Shared unmount dialog. Call open(dev) via a template ref; emits `done` after
   a successful unmount. `dev` must carry a mountpoint. */
const emit = defineEmits<{ done: [] }>()

const dlg = ref<{
  dev:     BlockDev
  rmFstab: boolean
  busy:    boolean
  err:     string
} | null>(null)

function open(dev: BlockDev) {
  dlg.value = { dev, rmFstab: false, busy: false, err: '' }
}

async function doUmount() {
  if (!dlg.value) return
  const d = dlg.value
  d.busy = true
  d.err  = ''
  try {
    await applyPlanned('umount', { mountpoint: d.dev.mountpoint, removeFromFstab: d.rmFstab },
      { title: t('uis.storage.DeviceUnmountDialog.unmount', { p0: d.dev.mountpoint }), actionLabel: t('uis.storage.DeviceUnmountDialog.unmount2') })
    dlg.value = null
    emit('done')
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? t('uis.storage.DeviceUnmountDialog.unmountFailed')
  } finally {
    if (dlg.value) d.busy = false
  }
}

defineExpose({ open })
</script>

<template>
  <Modal v-if="dlg" panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!dlg.busy" @close="dlg = null">
    <div class="px-5 py-4 border-b border-border">
      <h3 class="font-semibold text-foreground">{{ t('ui.storage.DeviceUnmountDialog.unmountDevice') }}</h3>
    </div>
    <div class="p-5 space-y-4">
      <Alert variant="warning" class="block p-3 text-xs text-warning" role="note">
        {{ t('ui.storage.DeviceUnmountDialog.makeSureNoApplicationIs') }} <span class="font-mono font-bold">{{ dlg.dev.mountpoint }}</span> {{ t('ui.storage.DeviceUnmountDialog.beforeUnmountingOrTheOperation') }}
      </Alert>
      <div class="space-y-1 text-xs text-muted-foreground">
        <div class="flex gap-2"><span class="w-20 text-foreground/80">{{ t('ui.storage.DeviceUnmountDialog.device') }}</span><span class="font-mono">/dev/{{ dlg.dev.name }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-foreground/80">{{ t('ui.storage.DeviceUnmountDialog.mountPoint') }}</span><span class="font-mono">{{ dlg.dev.mountpoint }}</span></div>
      </div>
      <label class="flex items-start gap-2.5 cursor-pointer">
        <Checkbox v-model="dlg.rmFstab" class="mt-0.5" />
        <div>
          <div class="text-xs font-medium text-foreground/80">{{ t('ui.storage.DeviceUnmountDialog.removeFromEtcFstab') }}</div>
          <div class="text-2xs text-muted-foreground">{{ t('ui.storage.DeviceUnmountDialog.alsoDeleteTheAutoMount') }}</div>
        </div>
      </label>
      <p v-if="dlg.err" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ dlg.err }}</p>
      <div class="flex gap-2 pt-1">
        <Button variant="outline" @click="dlg = null" class="flex-1 justify-center">{{ t('ui.storage.DeviceUnmountDialog.cancel') }}</Button>
        <Button @click="doUmount" :disabled="dlg.busy"
          class="flex-1 justify-center">
          <span v-if="dlg.busy">{{ t('ui.storage.DeviceUnmountDialog.unmounting') }}</span>
          <span v-else>{{ t('ui.storage.DeviceUnmountDialog.unmount') }}</span>
        </Button>
      </div>
    </div>
  </Modal>
</template>
