<script setup lang="ts">
import { ref } from 'vue'
import { trpc } from '../../../lib/trpc'
import { fmtBytes, type BlockDev } from '../../../composables/useStorageData'
import Modal from '../../ui/Modal.vue'

/* Shared 3-step format wizard used by every storage section. Call open(dev)
   via a template ref; it emits `done` after a successful format so the parent
   can refresh. */
const emit = defineEmits<{ done: [] }>()

type FsType = 'ext4' | 'xfs' | 'btrfs' | 'fat32'

const FS_OPTIONS: { id: FsType; name: string; tag: string; desc: string }[] = [
  { id: 'ext4',  name: 'ext4',  tag: 'Recommended', desc: 'Stable, journaled filesystem. Widely supported on Linux. Best for general use and NAS data.' },
  { id: 'xfs',   name: 'XFS',   tag: 'Large files',  desc: 'High-performance filesystem. Excellent for large media files and backups. Cannot be shrunk once created.' },
  { id: 'btrfs', name: 'Btrfs', tag: 'Advanced',    desc: 'Modern copy-on-write filesystem with built-in checksums and snapshot support. More complex to manage.' },
  { id: 'fat32', name: 'FAT32', tag: 'Cross-platform', desc: 'Compatible with Windows and macOS without drivers. No file permissions, 4 GB file size limit. For USB/external drives only.' },
]

const wiz = ref<{
  dev:     BlockDev
  step:    1 | 2 | 3
  fstype:  FsType
  label:   string
  confirm: string
  busy:    boolean
  err:     string
} | null>(null)

function open(dev: BlockDev) {
  wiz.value = { dev, step: 1, fstype: 'ext4', label: '', confirm: '', busy: false, err: '' }
}

async function doFormat() {
  if (!wiz.value) return
  const w = wiz.value
  if (w.confirm !== w.dev.name) return
  w.busy = true
  w.err  = ''
  try {
    const device = w.dev.path.replace(/^\/dev\//, '')
    await trpc.system.formatDisk.mutate({ device, fstype: w.fstype, label: w.label || undefined })
    wiz.value = null
    emit('done')
  } catch (e: unknown) {
    w.err = (e as { message?: string })?.message ?? 'Format failed'
  } finally {
    if (wiz.value) w.busy = false
  }
}

defineExpose({ open })
</script>

<template>
  <Modal v-if="wiz" panel-class="w-full max-w-md" :show-close="false" :prevent-close="!!wiz.busy" @close="wiz = null">

    <!-- Step indicator -->
    <div class="flex items-center gap-0 border-b border-[var(--c-border)]">
      <div v-for="(label, i) in ['Warning', 'Filesystem', 'Confirm']" :key="i"
        :class="['flex-1 py-2.5 text-center text-[11px] font-semibold transition-colors',
          wiz.step === i + 1 ? 'text-[var(--c-accent)] border-b-2 border-[var(--c-accent)]'
          : wiz.step > i + 1  ? 'text-[var(--c-text-3)]'
          : 'text-[var(--c-text-3)]/50']"
      >{{ i + 1 }}. {{ label }}</div>
    </div>

    <!-- Step 1: Warning -->
    <div v-if="wiz.step === 1" class="p-6 space-y-4">
      <div class="flex items-start gap-3 p-4 rounded-xl bg-danger/10 border border-danger/30">
        <svg class="w-5 h-5 text-danger mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
        </svg>
        <div>
          <div class="font-semibold text-danger text-sm mb-1">All data will be permanently erased</div>
          <div class="text-xs text-danger/80">
            Formatting <span class="font-mono font-bold">/dev/{{ wiz.dev.name }}</span> will destroy every file currently on this device. This operation cannot be undone.
          </div>
        </div>
      </div>

      <div class="space-y-1 text-xs text-[var(--c-text-3)]">
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Device</span><span class="font-mono">/dev/{{ wiz.dev.name }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(wiz.dev.size) }}</span></div>
        <div v-if="wiz.dev.fstype" class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Current FS</span><span class="font-mono">{{ wiz.dev.fstype }}</span></div>
        <div v-if="wiz.dev.model" class="flex gap-2"><span class="w-16 text-[var(--c-text-2)]">Model</span><span>{{ wiz.dev.model }}</span></div>
      </div>

      <div class="flex gap-2 pt-2">
        <button @click="wiz = null" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">Cancel</button>
        <button @click="wiz.step = 2" class="flex-1 py-2 text-sm rounded-lg bg-[var(--c-accent)] text-white hover:opacity-90 transition-opacity">I understand, continue →</button>
      </div>
    </div>

    <!-- Step 2: Choose filesystem -->
    <div v-else-if="wiz.step === 2" class="p-6 space-y-3">
      <p class="text-sm text-[var(--c-text-2)] font-medium mb-2">Choose a filesystem for <span class="font-mono text-[var(--c-text-1)]">/dev/{{ wiz.dev.name }}</span></p>

      <div class="space-y-2">
        <label
          v-for="fs in FS_OPTIONS" :key="fs.id"
          :class="['flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors',
            wiz.fstype === fs.id
              ? 'border-[var(--c-accent)] bg-[var(--c-accent)]/5'
              : 'border-[var(--c-border)] hover:border-[var(--c-border-strong)]']"
          @click="wiz.fstype = fs.id"
        >
          <div class="mt-0.5">
            <div :class="['w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors',
              wiz.fstype === fs.id ? 'border-[var(--c-accent)]' : 'border-[var(--c-border-strong)]']">
              <div v-if="wiz.fstype === fs.id" class="w-2 h-2 rounded-full bg-[var(--c-accent)]"/>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-[var(--c-text-1)]">{{ fs.name }}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded-sm"
                :class="fs.tag === 'Recommended' ? 'bg-success/15 text-success' : 'bg-[var(--c-surface-deep)] text-[var(--c-text-3)]'"
              >{{ fs.tag }}</span>
            </div>
            <div class="text-xs text-[var(--c-text-3)] mt-0.5 leading-relaxed">{{ fs.desc }}</div>
          </div>
        </label>
      </div>

      <div class="pt-1">
        <label class="block text-xs text-[var(--c-text-2)] mb-1">Volume label <span class="text-[var(--c-text-3)]">(optional)</span></label>
        <input
          v-model="wiz.label"
          type="text"
          placeholder="e.g. Data, Backup, Media"
          maxlength="64"
          class="w-full px-3 py-2 text-sm rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-[var(--c-accent)] transition-colors"
        />
      </div>

      <div class="flex gap-2 pt-1">
        <button @click="wiz.step = 1" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors">← Back</button>
        <button @click="wiz.step = 3" class="flex-1 py-2 text-sm rounded-lg bg-[var(--c-accent)] text-white hover:opacity-90 transition-opacity">Next →</button>
      </div>
    </div>

    <!-- Step 3: Confirm -->
    <div v-else-if="wiz.step === 3" class="p-6 space-y-4">
      <div class="space-y-1 text-xs text-[var(--c-text-3)]">
        <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Device</span><span class="font-mono">/dev/{{ wiz.dev.name }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Size</span><span>{{ fmtBytes(wiz.dev.size) }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Filesystem</span><span class="font-mono">{{ wiz.fstype }}</span></div>
        <div v-if="wiz.label" class="flex gap-2"><span class="w-20 text-[var(--c-text-2)]">Label</span><span>{{ wiz.label }}</span></div>
      </div>

      <div>
        <label class="block text-xs text-[var(--c-text-2)] mb-1.5">
          Type <span class="font-mono font-bold text-[var(--c-text-1)]">{{ wiz.dev.name }}</span> to confirm
        </label>
        <input
          v-model="wiz.confirm"
          type="text"
          :placeholder="wiz.dev.name"
          class="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder-[var(--c-text-3)] focus:outline-none focus:border-danger transition-colors"
        />
      </div>

      <div v-if="wiz.err" class="text-xs text-danger px-1">{{ wiz.err }}</div>

      <div class="flex gap-2">
        <button @click="wiz.step = 2" :disabled="wiz.busy" class="flex-1 py-2 text-sm rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors disabled:opacity-50">← Back</button>
        <button
          @click="doFormat"
          :disabled="wiz.confirm !== wiz.dev.name || wiz.busy"
          class="flex-1 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/85 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
        >
          <span v-if="wiz.busy">Formatting…</span>
          <span v-else>Format now</span>
        </button>
      </div>
    </div>

  </Modal>
</template>
