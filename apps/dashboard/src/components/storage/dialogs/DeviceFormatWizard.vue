<script setup lang="ts">
import { Alert } from '@/components/ui/alert'
import { TriangleAlertIcon } from '@lucide/vue'
import { applyPlanned } from '../../../lib/plan'
import { ref } from 'vue'
import { fmtBytes, type BlockDev } from '../store'
import Modal from '../../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/* Shared 3-step format wizard used by every storage section. Call open(dev)
   via a template ref; it emits `done` after a successful format so the parent
   can refresh, then offers to mount the new filesystem: `mount` hands the
   device to the parent's mount dialog, where access is chosen. */
const emit = defineEmits<{ done: []; mount: [dev: BlockDev] }>()

type FsType = 'ext4' | 'xfs' | 'btrfs' | 'fat32'

const FS_OPTIONS: { id: FsType; name: string; tag: string; desc: string }[] = [
  { id: 'ext4',  name: 'ext4',  tag: 'Recommended', desc: 'Stable, journaled filesystem. Widely supported on Linux. Best for general use and NAS data.' },
  { id: 'xfs',   name: 'XFS',   tag: 'Large files',  desc: 'High-performance filesystem. Excellent for large media files and backups. Cannot be shrunk once created.' },
  { id: 'btrfs', name: 'Btrfs', tag: 'Advanced',    desc: 'Modern copy-on-write filesystem with built-in checksums and snapshot support. More complex to manage.' },
  { id: 'fat32', name: 'FAT32', tag: 'Cross-platform', desc: 'Compatible with Windows and macOS without drivers. No file permissions, 4 GB file size limit. For USB/external drives only.' },
]

const wiz = ref<{
  dev:     BlockDev
  step:    1 | 2 | 3 | 4
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
    await applyPlanned('format', { device, fstype: w.fstype, label: w.label || undefined },
      { title: `Format ${w.dev.path}`, actionLabel: `Format ${w.dev.path}` })
    w.step = 4
    emit('done')
  } catch (e: unknown) {
    w.err = (e as { message?: string })?.message ?? 'Format failed'
  } finally {
    if (wiz.value) w.busy = false
  }
}

function mountNow() {
  if (!wiz.value) return
  const dev = { ...wiz.value.dev, fstype: wiz.value.fstype === 'fat32' ? 'vfat' : wiz.value.fstype }
  wiz.value = null
  emit('mount', dev)
}

defineExpose({ open })
</script>

<template>
  <Modal v-if="wiz" panel-class="w-full max-w-md" :show-close="false" :prevent-close="!!wiz.busy" @close="wiz = null">

    <!-- Step indicator -->
    <div v-if="wiz.step < 4" class="flex items-center gap-0 border-b border-border">
      <div v-for="(label, i) in ['Warning', 'Filesystem', 'Confirm']" :key="i"
        :class="['flex-1 py-2.5 text-center text-2xs font-semibold transition-colors',
          wiz.step === i + 1 ? 'text-primary border-b-2 border-primary'
          : wiz.step > i + 1  ? 'text-muted-foreground'
          : 'text-muted-foreground/50']"
      >{{ i + 1 }}. {{ label }}</div>
    </div>

    <!-- Step 1: Warning -->
    <div v-if="wiz.step === 1" class="p-6 space-y-4">
      <Alert variant="destructive" class="flex items-start gap-3 p-4 text-foreground" role="note">
        <TriangleAlertIcon class="w-5 h-5 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <div class="font-semibold text-destructive text-sm mb-1">All data will be permanently erased</div>
          <div class="text-xs text-destructive/80">
            Formatting <span class="font-mono font-bold">/dev/{{ wiz.dev.name }}</span> will destroy every file currently on this device. This operation cannot be undone.
          </div>
        </div>
      </Alert>

      <div class="space-y-1 text-xs text-muted-foreground">
        <div class="flex gap-2"><span class="w-16 text-foreground/80">Device</span><span class="font-mono">/dev/{{ wiz.dev.name }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-foreground/80">Size</span><span>{{ fmtBytes(wiz.dev.size) }}</span></div>
        <div v-if="wiz.dev.fstype" class="flex gap-2"><span class="w-16 text-foreground/80">Current FS</span><span class="font-mono">{{ wiz.dev.fstype }}</span></div>
        <div v-if="wiz.dev.model" class="flex gap-2"><span class="w-16 text-foreground/80">Model</span><span>{{ wiz.dev.model }}</span></div>
      </div>

      <div class="flex gap-2 pt-2">
        <Button variant="outline" @click="wiz = null" class="flex-1 justify-center">Cancel</Button>
        <Button @click="wiz.step = 2" class="flex-1 justify-center">I understand, continue →</Button>
      </div>
    </div>

    <!-- Step 2: Choose filesystem -->
    <div v-else-if="wiz.step === 2" class="p-6 space-y-3">
      <p class="text-sm text-foreground/80 font-medium mb-2">Choose a filesystem for <span class="font-mono text-foreground">/dev/{{ wiz.dev.name }}</span></p>

      <div class="space-y-2">
        <label
          v-for="fs in FS_OPTIONS" :key="fs.id"
          :class="['flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors',
            wiz.fstype === fs.id
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-input']"
          @click="wiz.fstype = fs.id"
        >
          <div class="mt-0.5">
            <div :class="['w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors',
              wiz.fstype === fs.id ? 'border-primary' : 'border-input']">
              <div v-if="wiz.fstype === fs.id" class="w-2 h-2 rounded-full bg-primary"/>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-foreground">{{ fs.name }}</span>
              <span class="text-2xs px-1.5 py-0.5 rounded-sm"
                :class="fs.tag === 'Recommended' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'"
              >{{ fs.tag }}</span>
            </div>
            <div class="text-xs text-muted-foreground mt-0.5 leading-relaxed">{{ fs.desc }}</div>
          </div>
        </label>
      </div>

      <div class="pt-1">
        <label class="block text-xs text-foreground/80 mb-1">Volume label <span class="text-muted-foreground">(optional)</span></label>
        <Input
          v-model="wiz.label"
          type="text"
          placeholder="e.g. Data, Backup, Media"
          maxlength="64"
          class="w-full px-3 py-2 text-sm placeholder-muted-foreground"
        />
      </div>

      <div class="flex gap-2 pt-1">
        <Button variant="outline" @click="wiz.step = 1" class="flex-1 justify-center">← Back</Button>
        <Button @click="wiz.step = 3" class="flex-1 justify-center">Next →</Button>
      </div>
    </div>

    <!-- Step 3: Confirm -->
    <div v-else-if="wiz.step === 3" class="p-6 space-y-4">
      <div class="space-y-1 text-xs text-muted-foreground">
        <div class="flex gap-2"><span class="w-20 text-foreground/80">Device</span><span class="font-mono">/dev/{{ wiz.dev.name }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-foreground/80">Size</span><span>{{ fmtBytes(wiz.dev.size) }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-foreground/80">Filesystem</span><span class="font-mono">{{ wiz.fstype }}</span></div>
        <div v-if="wiz.label" class="flex gap-2"><span class="w-20 text-foreground/80">Label</span><span>{{ wiz.label }}</span></div>
      </div>

      <div>
        <label class="block text-xs text-foreground/80 mb-1.5">
          Type <span class="font-mono font-bold text-foreground">{{ wiz.dev.name }}</span> to confirm
        </label>
        <Input
          v-model="wiz.confirm"
          type="text"
          :placeholder="wiz.dev.name"
          class="w-full px-3 py-2 text-sm font-mono placeholder-muted-foreground"
        />
      </div>

      <p v-if="wiz.err" role="alert" class="px-1 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ wiz.err }}</p>

      <div class="flex gap-2">
        <Button variant="outline" @click="wiz.step = 2" :disabled="wiz.busy" class="flex-1 justify-center">← Back</Button>
        <Button variant="destructive"
          @click="doFormat"
          :disabled="wiz.confirm !== wiz.dev.name || wiz.busy"
          class="flex-1 justify-center"
        >
          <span v-if="wiz.busy">Formatting…</span>
          <span v-else>Format now</span>
        </Button>
      </div>
    </div>

    <!-- Done: a new filesystem is root-owned until it is mounted with access set up -->
    <div v-else class="p-6 space-y-4">
      <div>
        <div class="font-semibold text-sm text-foreground">Formatted</div>
        <p class="text-xs text-muted-foreground mt-1">
          <span class="font-mono">/dev/{{ wiz.dev.name }}</span> now holds an empty {{ wiz.fstype }} filesystem.
          Mount it to choose who can write to it and to create a Place for it.
        </p>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" @click="wiz = null" class="flex-1 justify-center">Later</Button>
        <Button @click="mountNow" class="flex-1 justify-center">Mount now…</Button>
      </div>
    </div>

  </Modal>
</template>
