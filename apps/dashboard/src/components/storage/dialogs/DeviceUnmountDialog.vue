<script setup lang="ts">
import { applyPlanned } from '../../../lib/plan'
import { ref } from 'vue'
import { type BlockDev } from '../store'
import Modal from '../../ui/Modal.vue'
import { Button } from '@/components/ui/button'

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
      { title: `Unmount ${d.dev.mountpoint}`, actionLabel: 'Unmount' })
    dlg.value = null
    emit('done')
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? 'Unmount failed'
  } finally {
    if (dlg.value) d.busy = false
  }
}

defineExpose({ open })
</script>

<template>
  <Modal v-if="dlg" panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!dlg.busy" @close="dlg = null">
    <div class="px-5 py-4 border-b border-border">
      <h3 class="font-semibold text-foreground">Unmount device</h3>
    </div>
    <div class="p-5 space-y-4">
      <div class="p-3 rounded-lg bg-warning/5 border border-warning/15 text-xs text-warning">
        Make sure no application is using files on <span class="font-mono font-bold">{{ dlg.dev.mountpoint }}</span> before unmounting, or the operation will fail.
      </div>
      <div class="space-y-1 text-xs text-muted-foreground">
        <div class="flex gap-2"><span class="w-20 text-foreground/80">Device</span><span class="font-mono">/dev/{{ dlg.dev.name }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-foreground/80">Mount point</span><span class="font-mono">{{ dlg.dev.mountpoint }}</span></div>
      </div>
      <label class="flex items-start gap-2.5 cursor-pointer">
        <input v-model="dlg.rmFstab" type="checkbox" class="mt-0.5 accent-primary"/>
        <div>
          <div class="text-xs font-medium text-foreground/80">Remove from /etc/fstab</div>
          <div class="text-2xs text-muted-foreground">Also delete the auto-mount entry so the drive stays unmounted after reboots.</div>
        </div>
      </label>
      <p v-if="dlg.err" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ dlg.err }}</p>
      <div class="flex gap-2 pt-1">
        <Button variant="outline" @click="dlg = null" class="flex-1 justify-center">Cancel</Button>
        <Button @click="doUmount" :disabled="dlg.busy"
          class="flex-1 justify-center">
          <span v-if="dlg.busy">Unmounting…</span>
          <span v-else>Unmount</span>
        </Button>
      </div>
    </div>
  </Modal>
</template>
