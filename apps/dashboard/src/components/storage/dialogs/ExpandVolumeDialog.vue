<script setup lang="ts">
import { ref, computed } from 'vue'
import { trpc } from '../../../lib/trpc'
import { applyPlanned } from '../../../lib/plan'
import { fmtBytes } from '../store'
import Modal from '../../ui/Modal.vue'
import { optionLabel, needsBackup, erasesADisk, type ExpandMode } from '../expand'

/* Expand a volume (#7). open(volume) lists the ways it can grow; choosing one
   opens the plan review. Emits `done` once the plan ran. */
const emit = defineEmits<{ done: [pending: boolean] }>()

type Options = Awaited<ReturnType<typeof trpc.storage.volumes.expandOptions.query>>

const dlg = ref<{
  id: string
  name: string
  loading: boolean
  options: Options['options']
  reason: string
  mode: ExpandMode | ''
  disk: string
  busy: boolean
  err: string
} | null>(null)

async function open(v: { id: string; name: string }) {
  dlg.value = { id: v.id, name: v.name, loading: true, options: [], reason: '', mode: '', disk: '', busy: false, err: '' }
  try {
    const r = await trpc.storage.volumes.expandOptions.query({ id: v.id })
    if (!dlg.value) return
    dlg.value.options = r.options
    dlg.value.reason = r.reason ?? ''
    const first = r.options[0]
    if (first) pick(first.mode as ExpandMode)
  } catch (e) {
    if (dlg.value) dlg.value.err = e instanceof Error ? e.message : String(e)
  } finally {
    if (dlg.value) dlg.value.loading = false
  }
}

const chosen = computed(() => dlg.value?.options.find(o => o.mode === dlg.value?.mode))

function pick(mode: ExpandMode) {
  if (!dlg.value) return
  dlg.value.mode = mode
  dlg.value.disk = dlg.value.options.find(o => o.mode === mode)?.disks?.[0]?.name ?? ''
}

async function expand() {
  const d = dlg.value
  if (!d || !d.mode) return
  const mode = d.mode
  d.busy = true
  d.err = ''
  try {
    const res = await applyPlanned('volume.expand', { uuid: d.id, mode, ...(d.disk && chosen.value?.disks ? { disk: d.disk } : {}) }, {
      title: `Expand the volume ${d.name}`,
      actionLabel: 'Expand',
      danger: erasesADisk(mode),
      acknowledge: needsBackup(mode) ? 'I have a backup of this volume' : undefined,
    })
    dlg.value = null
    emit('done', res.pending === true)
  } catch (e) {
    d.err = e instanceof Error ? e.message : String(e)
  } finally {
    if (dlg.value) d.busy = false
  }
}

defineExpose({ open })
</script>

<template>
  <Modal v-if="dlg" panel-class="w-full max-w-md" :show-close="false" :prevent-close="dlg.busy" @close="dlg = null">
    <div class="px-5 py-4 border-b border-[var(--c-border)]">
      <h3 class="font-semibold text-[var(--c-text-1)]">Expand {{ dlg.name }}</h3>
    </div>
    <div class="p-5 space-y-4">
      <p v-if="dlg.loading" class="text-sm text-[var(--c-text-3)]">Looking at what this volume can use…</p>
      <p v-else-if="!dlg.options.length" class="text-sm text-[var(--c-text-2)]">{{ dlg.reason || 'Nothing to grow into right now.' }}</p>
      <div v-else class="space-y-2">
        <label v-for="o in dlg.options" :key="o.mode" class="flex items-start gap-2.5 rounded-lg border border-[var(--c-border)] px-3 py-2 cursor-pointer"
          :class="dlg.mode === o.mode ? 'border-[var(--c-accent)]' : ''">
          <input type="radio" name="expand-mode" class="mt-1 accent-accent" :checked="dlg.mode === o.mode" @change="pick(o.mode as ExpandMode)" />
          <span class="text-sm text-[var(--c-text-1)]">{{ optionLabel(o.mode as ExpandMode, o.gain) }}</span>
        </label>
        <div v-if="chosen?.disks?.length" class="pt-1">
          <label class="text-xs text-[var(--c-text-2)]" for="expand-disk">Disk to add (everything on it is erased)</label>
          <select id="expand-disk" v-model="dlg.disk" class="ui-input mt-1 w-full font-mono">
            <option v-for="d in chosen.disks" :key="d.name" :value="d.name">/dev/{{ d.name }} · {{ fmtBytes(d.size) }}</option>
          </select>
        </div>
        <p v-if="dlg.mode === 'addDisk'" class="status-text text-warning"><span class="status-tag">[WARN]</span> The volume will depend on one more disk: if any of them fails, the volume is lost.</p>
        <p v-if="dlg.mode === 'raidAddDisk' || dlg.mode === 'mirrorGrow'" class="text-xs text-[var(--c-text-3)]">The array is rewritten in the background (hours on large disks); the volume stays usable, and HSI grows it when that is done.</p>
      </div>
      <p v-if="dlg.err" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ dlg.err }}</p>
      <div class="flex gap-2 pt-1">
        <button class="btn btn-outline flex-1 justify-center" @click="dlg = null">Cancel</button>
        <button class="btn btn-primary flex-1 justify-center" :disabled="dlg.busy || !dlg.mode" @click="expand">Review the plan</button>
      </div>
    </div>
  </Modal>
</template>
