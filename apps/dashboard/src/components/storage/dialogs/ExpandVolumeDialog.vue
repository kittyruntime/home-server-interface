<script setup lang="ts">
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ref, computed } from 'vue'
import { trpc } from '../../../lib/trpc'
import { applyPlanned } from '../../../lib/plan'
import { fmtBytes } from '../store'
import Modal from '../../ui/Modal.vue'
import { optionLabel, needsBackup, erasesADisk, type ExpandMode } from '../expand'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

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
    <div class="px-5 py-4 border-b border-border">
      <h3 class="font-semibold text-foreground">Expand {{ dlg.name }}</h3>
    </div>
    <div class="p-5 space-y-4">
      <p v-if="dlg.loading" class="text-sm text-muted-foreground">Looking at what this volume can use…</p>
      <p v-else-if="!dlg.options.length" class="text-sm text-foreground/80">{{ dlg.reason || 'Nothing to grow into right now.' }}</p>
      <div v-else class="space-y-2">
        <RadioGroup :model-value="dlg.mode" class="gap-2" @update:model-value="mode => pick(mode as ExpandMode)">
          <label v-for="o in dlg.options" :key="o.mode" class="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2 cursor-pointer"
            :class="dlg.mode === o.mode ? 'border-primary' : ''">
            <RadioGroupItem :value="o.mode" class="mt-0.5" />
            <span class="text-sm text-foreground">{{ optionLabel(o.mode as ExpandMode, o.gain) }}</span>
          </label>
        </RadioGroup>
        <div v-if="chosen?.disks?.length" class="pt-1">
          <label class="text-xs text-foreground/80" for="expand-disk">Disk to add (everything on it is erased)</label>
          <NativeSelect wrapper-class="mt-1 w-full" id="expand-disk" v-model="dlg.disk" class="font-mono">
            <NativeSelectOption v-for="d in chosen.disks" :key="d.name" :value="d.name">/dev/{{ d.name }} · {{ fmtBytes(d.size) }}</NativeSelectOption>
          </NativeSelect>
        </div>
        <p v-if="dlg.mode === 'addDisk'" class="status-text text-warning"><span class="status-tag">[WARN]</span> The volume will depend on one more disk: if any of them fails, the volume is lost.</p>
        <p v-if="dlg.mode === 'raidAddDisk' || dlg.mode === 'mirrorGrow'" class="text-xs text-muted-foreground">The array is rewritten in the background (hours on large disks); the volume stays usable, and HSI grows it when that is done.</p>
      </div>
      <p v-if="dlg.err" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ dlg.err }}</p>
      <div class="flex gap-2 pt-1">
        <Button variant="outline" class="flex-1 justify-center" @click="dlg = null">Cancel</Button>
        <Button class="flex-1 justify-center" :disabled="dlg.busy || !dlg.mode" @click="expand">Review the plan</Button>
      </div>
    </div>
  </Modal>
</template>
