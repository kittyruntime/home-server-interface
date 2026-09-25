<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import { useConfirm } from '../../lib/confirm'

/* Existing storage found on the disks but not in use yet (after a reinstall,
   or disks moved from another machine). Import never formats anything: arrays
   are assembled from their own superblocks, volume groups are activated. The
   filesystems they hold then appear in Mounts, ready to be mounted. */
const props = defineProps<{ kind: 'raid' | 'lvm'; usedMdNames: string[] }>()
const emit = defineEmits<{ imported: [] }>()

type Scan = Awaited<ReturnType<typeof trpc.storage.importScan.query>>
const scan = ref<Scan | null>(null)
const busy = ref<string | null>(null)
const toast = useToast()
const { confirm } = useConfirm()

async function load() {
  try { scan.value = await trpc.storage.importScan.query() } catch { scan.value = null }
}
onMounted(load)

function nextMdName(): string {
  const used = new Set(props.usedMdNames)
  for (let i = 0; i < 128; i++) if (!used.has(`md${i}`)) return `md${i}`
  return 'md127'
}

async function assemble(a: Scan['arrays'][number]) {
  const degraded = a.missing > 0
  if (degraded && !await confirm(
    `${a.missing} of ${a.expected} members of this array were not found. Starting it degraded leaves no redundancy until the missing disk is replaced. If a disk is only unplugged, plug it in and scan again instead.`,
    { danger: true, confirmLabel: 'Start degraded' },
  )) return
  busy.value = a.uuid
  try {
    const res = await trpc.storage.importAssembleRaid.mutate({ uuid: a.uuid, name: nextMdName(), allowDegraded: degraded })
    for (const w of res.warnings ?? []) toast.error(w)
    toast.success(`Array assembled as ${res.device}`)
    emit('imported')
    await load()
  } catch (e: any) {
    toast.error(e?.message ?? 'Could not assemble the array')
  } finally {
    busy.value = null
  }
}

async function activate(vg: Scan['vgs'][number]) {
  busy.value = vg.name
  try {
    await trpc.storage.importActivateVg.mutate({ name: vg.name })
    toast.success(`Volume group ${vg.name} activated`)
    emit('imported')
    await load()
  } catch (e: any) {
    toast.error(e?.message ?? 'Could not activate the volume group')
  } finally {
    busy.value = null
  }
}

defineExpose({ load })
</script>

<template>
  <div v-if="kind === 'raid' && scan?.arrays.length" class="mb-5 rounded-xl border border-info/30 bg-info/5 p-4">
    <h3 class="text-sm font-semibold text-[var(--c-text-1)]">Arrays found on disks</h3>
    <p class="text-xs text-[var(--c-text-3)] mt-0.5 mb-3">These arrays exist on the disks but are not running. Assembling one keeps its data; nothing is formatted.</p>
    <div v-for="a in scan.arrays" :key="a.uuid" class="flex flex-wrap items-center gap-3 py-2 border-t border-[var(--c-border)] first:border-t-0">
      <div class="min-w-0 flex-1">
        <div class="text-sm text-[var(--c-text-1)]">
          <span class="font-mono">{{ a.name || a.device }}</span>
          <span class="text-xs text-[var(--c-text-3)] ml-2 uppercase">{{ a.level }}</span>
        </div>
        <div class="text-[11px] text-[var(--c-text-3)] font-mono break-all">{{ a.members.join(' + ') }}</div>
        <div v-if="a.missing > 0" class="text-[11px] text-warning">{{ a.missing }} of {{ a.expected }} members not found</div>
      </div>
      <button type="button" class="btn btn-primary btn-xs" :disabled="busy !== null" @click="assemble(a)">
        {{ busy === a.uuid ? 'Assembling…' : a.missing > 0 ? 'Start degraded…' : 'Assemble' }}
      </button>
    </div>
  </div>

  <div v-if="kind === 'lvm' && scan?.vgs.length" class="mb-5 rounded-xl border border-info/30 bg-info/5 p-4">
    <h3 class="text-sm font-semibold text-[var(--c-text-1)]">Inactive volume groups</h3>
    <p class="text-xs text-[var(--c-text-3)] mt-0.5 mb-3">These volume groups exist on the disks but none of their volumes is active. Activating keeps their data; nothing is formatted.</p>
    <div v-for="vg in scan.vgs" :key="vg.name" class="flex flex-wrap items-center gap-3 py-2 border-t border-[var(--c-border)] first:border-t-0">
      <div class="min-w-0 flex-1">
        <div class="text-sm font-mono text-[var(--c-text-1)]">{{ vg.name }}</div>
        <div class="text-[11px] text-[var(--c-text-3)] font-mono break-all">{{ vg.lvs.join(', ') }}</div>
      </div>
      <button type="button" class="btn btn-primary btn-xs" :disabled="busy !== null" @click="activate(vg)">
        {{ busy === vg.name ? 'Activating…' : 'Activate' }}
      </button>
    </div>
  </div>
</template>
