<script setup lang="ts">
import { ref } from 'vue'
import { trpc } from '../../../lib/trpc'
import { fmtBytes, type BlockDev } from '../../../composables/useStorageData'
import Modal from '../../ui/Modal.vue'

/* Shared mount dialog. Call open(dev) via a template ref; emits `done` after a
   successful mount. */
const emit = defineEmits<{ done: [] }>()

const dlg = ref<{
  dev:     BlockDev
  mp:      string
  options: string
  persist: boolean
  busy:    boolean
  err:     string
} | null>(null)

function open(dev: BlockDev) {
  dlg.value = { dev, mp: `/mnt/${dev.name}`, options: 'defaults', persist: true, busy: false, err: '' }
}

async function doMount() {
  if (!dlg.value) return
  const d = dlg.value
  d.busy = true
  d.err  = ''
  try {
    const device = d.dev.path.replace(/^\/dev\//, '')
    await trpc.system.mountDevice.mutate({ device, mountpoint: d.mp, options: d.options || undefined, persist: d.persist })
    dlg.value = null
    emit('done')
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? 'Mount failed'
  } finally {
    if (dlg.value) d.busy = false
  }
}

defineExpose({ open })
</script>

<template>
  <Modal v-if="dlg" panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!dlg.busy" @close="dlg = null">
    <div class="px-5 py-4 border-b border-[var(--c-border)]">
      <h3 class="font-semibold text-[var(--c-text-1)]">Mount device</h3>
      <p class="text-xs text-[var(--c-text-3)] mt-0.5">
        <span class="font-mono">{{ dlg.dev.path }}</span>
        <span v-if="dlg.dev.fstype"> · {{ dlg.dev.fstype }}</span>
        · {{ fmtBytes(dlg.dev.size) }}
      </p>
    </div>
    <div class="p-5 space-y-4">
      <div>
        <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">Mount point</label>
        <input
          v-model="dlg.mp"
          type="text"
          class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)] transition-colors"
        />
        <p class="text-[10px] text-[var(--c-text-3)] mt-1">Directory will be created if it doesn't exist.</p>
      </div>
      <div>
        <label class="block text-xs font-medium text-[var(--c-text-2)] mb-1.5">Mount options</label>
        <input
          v-model="dlg.options"
          type="text"
          placeholder="defaults"
          class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)] transition-colors"
        />
      </div>
      <label class="flex items-start gap-2.5 cursor-pointer">
        <input v-model="dlg.persist" type="checkbox" class="mt-0.5 accent-accent"/>
        <div>
          <div class="text-xs font-medium text-[var(--c-text-2)]">Persist across reboots</div>
          <div class="text-[10px] text-[var(--c-text-3)]">Add a UUID-based entry to /etc/fstab so the drive is auto-mounted on boot.</div>
        </div>
      </label>
      <div v-if="dlg.err" class="text-xs text-danger">{{ dlg.err }}</div>
      <div class="flex gap-2 pt-1">
        <button @click="dlg = null" class="btn btn-outline flex-1 justify-center">Cancel</button>
        <button @click="doMount" :disabled="!dlg.mp || dlg.busy"
          class="btn btn-primary flex-1 justify-center">
          <span v-if="dlg.busy">Mounting…</span>
          <span v-else>Mount</span>
        </button>
      </div>
    </div>
  </Modal>
</template>
