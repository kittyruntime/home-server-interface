<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { PlusIcon, DownloadIcon, ChevronRightIcon } from '@lucide/vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { useToast } from '../../lib/toast'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import Modal from '../ui/Modal.vue'
import LoadingState from '../ui/LoadingState.vue'
import StorageIntro from './StorageIntro.vue'
import TermHelp from './TermHelp.vue'
import TypeBadge from './TypeBadge.vue'
import CreatePoolDialog from './CreatePoolDialog.vue'
import RaidSection from './RaidSection.vue'
import LvmSection from './LvmSection.vue'
import { useStorageData, fmtBytes, raidLevelLabel } from './store'
import { useHostTools } from './tools'
import { loadZfs, zfs } from './zfs-data'
import { missingWatched } from './pool-summary'
import { poolRows, type PoolRow, type PoolType } from './storage-model'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'

// Every pool, whatever its type: mdadm arrays, LVM volume groups, ZFS pools.
// Their own actions are on their pages; creating one starts with its type.
// `preselect`: free disks picked in Disks, for the RAID or LVM create wizard.
const props = defineProps<{ preselect?: { kind: 'raid' | 'lvm'; devices: string[] } }>()
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation]; preselected: [] }>()
const { t } = useI18n()
const toast = useToast()
const { loading, raids, devices, lvmPVs, lvmVGs, refresh } = useStorageData()
const { isMissing } = useHostTools()
onMounted(() => { void loadZfs() })

const rows = computed(() => poolRows({
  raids: raids.value, devices: devices.value, pvs: lvmPVs.value, vgs: lvmVGs.value,
  pools: zfs.value?.pools ?? [], datasets: zfs.value?.datasets ?? [],
}))
const zfsReady = computed(() => !!zfs.value?.available)
const missing = computed(() => (zfs.value ? missingWatched(zfs.value.watched, zfs.value.pools) : []))
const bootOff = computed(() => zfsReady.value && !!zfs.value?.bootUnits && (!zfs.value.bootUnits.importCache || !zfs.value.bootUnits.mount))

// ── Create: the type first, then that type's own wizard ─────────────────────
const choosing = ref(false)
const choice = ref<PoolType>('zfs')
const creating = ref<PoolType | null>(null)
const picked = ref<string[] | undefined>(undefined)
watch(() => props.preselect, p => {
  if (!p?.devices.length) return
  picked.value = p.devices
  creating.value = p.kind === 'raid' ? 'md' : 'lvm'
  emit('preselected')
}, { immediate: true })
const freeDisks = ref<Array<{ name: string; size: number; model: string; serial?: string }>>([])
const TYPES = computed(() => ([
  { id: 'zfs' as const, off: !zfsReady.value, why: t('ui.storage.Pools.zfsMissing') },
  { id: 'md' as const, off: isMissing('mdadm'), why: t('ui.storage.RaidSection.toolsNotInstalled') },
  { id: 'lvm' as const, off: isMissing('lvm'), why: t('ui.storage.RaidSection.toolsNotInstalled') },
]))
function openChooser() {
  choice.value = TYPES.value.find(x => !x.off)?.id ?? 'zfs'
  choosing.value = true
}
async function startCreate() {
  choosing.value = false
  if (choice.value === 'zfs') {
    try { freeDisks.value = (await trpc.storage.volumes.overview.query()).freeDisks } catch { freeDisks.value = [] }
  }
  creating.value = choice.value
}
function created(loc?: StorageLocation) {
  creating.value = null
  picked.value = undefined
  void refresh(); void loadZfs()
  if (loc) emit('navigate', loc)
}

async function unwatch(name: string) {
  try {
    await applyPlanned('zfs.unwatch', { name }, { title: t('ui.storage.Zfs.unwatchTitle', { name }), actionLabel: t('ui.storage.Zfs.unwatch'), notice: t('ui.storage.Zfs.unwatchMissingHint') })
    toast.success(t('ui.storage.Zfs.unwatchedToast', { name }))
    await loadZfs()
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}

const ZFS_LAYOUT: Record<string, string> = { stripe: 'stripe', mirror: 'mirror', raidz1: 'raidz1', raidz2: 'raidz2', raidz3: 'raidz3', mixed: 'mixed' }
const layoutText = (r: PoolRow) => r.type === 'md' ? raidLevelLabel(r.layout)
  : r.type === 'lvm' ? t('ui.storage.Pools.layoutVg')
  : t(`ui.storage.Pools.zfsLayout.${ZFS_LAYOUT[r.layout] ?? 'mixed'}`)
const holdsText = (r: PoolRow) => !r.holds ? ''
  : r.holds.kind === 'vg' ? t('ui.storage.Pools.holdsVg', { name: r.holds.name })
  : r.holds.kind === 'volumes' ? t('ui.storage.Pools.holdsVolumes', { n: r.holds.n }, r.holds.n)
  : t('ui.storage.Pools.holdsDatasets', { n: r.holds.n }, r.holds.n)
const usedPct = (r: PoolRow) => (r.used != null && r.size ? Math.round((r.used / r.size) * 100) : null)
const HEALTH_CLASS: Record<PoolRow['health'], string> = {
  ok: 'badge-ghost text-success', rebuilding: 'badge-ghost text-info', degraded: 'badge-warning', failed: 'badge-error',
}
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div class="min-w-0 flex-1 basis-56">
        <h2 class="flex items-center gap-1.5 text-lg font-semibold text-base-content">{{ t('ui.storage.Pools.heading') }}<TermHelp term="array" /></h2>
        <p class="mt-0.5 text-sm text-base-content/70">{{ t('ui.storage.Pools.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="ghost" size="sm" @click="emit('navigate', { kind: 'import' })"><DownloadIcon class="size-4" aria-hidden="true" />{{ t('ui.storage.Pools.import') }}</Button>
        <Button size="sm" @click="openChooser"><PlusIcon class="size-4" aria-hidden="true" />{{ t('ui.storage.Pools.create') }}</Button>
      </div>
    </div>
    <StorageIntro tab="pools" />
    <Alert v-if="bootOff" variant="warning" class="mb-4 block" role="note">{{ t('ui.storage.Zfs.bootUnitsOff') }} <code class="font-mono">systemctl enable zfs-import-cache.service zfs-mount.service</code></Alert>
    <Card v-for="w in missing" :key="w.guid" class="mb-4 block gap-0 py-0 shadow-none border-error/40 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-mono font-semibold">{{ w.name }}</span><TypeBadge type="zfs" />
        <span class="badge badge-error badge-sm">{{ t('ui.storage.Zfs.missing') }}</span>
        <Button variant="outline" size="xs" class="ml-auto" @click="unwatch(w.name)">{{ t('ui.storage.Zfs.unwatch') }}</Button>
      </div>
      <p class="mt-2 text-xs text-base-content/80">{{ t('ui.storage.Zfs.missingLine', { n: w.datasets.length }, w.datasets.length) }}</p>
    </Card>

    <LoadingState v-if="loading && !rows.length" variant="block" />
    <Card v-else-if="!rows.length" class="block gap-0 py-0 shadow-none px-4 py-8 text-center text-sm text-base-content/70">{{ t('ui.storage.Pools.none') }}</Card>
    <ul v-else class="space-y-3">
      <li v-for="r in rows" :key="`${r.type}:${r.name}`">
        <button type="button" class="group block w-full rounded-box border bg-base-100 p-4 text-left transition-colors hover:bg-base-200/50 focus-visible:outline-2 focus-visible:outline-offset-2"
          :class="r.health === 'degraded' || r.health === 'failed' ? 'border-warning/60' : 'border-base-300'"
          @click="emit('navigate', r.location)">
          <span class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-base font-semibold text-base-content">{{ r.name }}</span>
            <TypeBadge :type="r.type" />
            <span class="text-xs text-base-content/70">{{ layoutText(r) }}<template v-if="r.on.length"> · {{ t('ui.storage.Pools.members', { n: r.on.length }, r.on.length) }}</template></span>
            <span class="badge badge-sm" :class="HEALTH_CLASS[r.health]">{{ t(`ui.storage.Pools.health.${r.health}`) }}</span>
            <span class="ml-auto text-xs tabular-nums text-base-content/70">
              <template v-if="usedPct(r) != null">{{ t('ui.storage.Pools.usedOf', { pct: usedPct(r), size: fmtBytes(r.size) }) }}</template>
              <template v-else>{{ fmtBytes(r.size) }}</template>
            </span>
            <ChevronRightIcon class="size-4 shrink-0 text-base-content/40 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </span>
          <span v-if="usedPct(r) != null || r.progress != null" class="mt-3 block h-1.5 overflow-hidden rounded-full bg-base-300">
            <span class="block h-full rounded-full" :class="r.progress != null ? 'bg-info' : r.health === 'ok' ? 'bg-base-content/70' : 'bg-warning'"
              :style="{ width: `${r.progress ?? usedPct(r)}%` }" />
          </span>
          <span class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-base-content/70">
            <span v-if="r.on.length">{{ t('ui.storage.Pools.on') }} <span class="font-mono">{{ r.on.join(', ') }}</span></span>
            <span v-if="r.holds">{{ holdsText(r) }}</span>
            <span v-if="r.progress != null" class="text-info">{{ t('ui.storage.Pools.progress', { pct: r.progress }) }}</span>
          </span>
        </button>
      </li>
    </ul>

    <Modal v-if="choosing" :label="t('ui.storage.Pools.chooseHeading')" panel-class="w-full max-w-xl" @close="choosing = false">
      <template #header>
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-base-content">{{ t('ui.storage.Pools.chooseHeading') }}</h3>
          <p class="mt-0.5 text-xs text-base-content/70">{{ t('ui.storage.Pools.chooseSubtitle') }}</p>
        </div>
      </template>
      <div class="grid gap-2 p-5" role="radiogroup" :aria-label="t('ui.storage.Pools.chooseHeading')">
        <label v-for="x in TYPES" :key="x.id" class="flex gap-3 rounded-box border border-base-300 p-3"
          :class="x.off ? 'opacity-60' : 'cursor-pointer hover:bg-base-200 has-[:checked]:border-base-content/40 has-[:checked]:bg-base-200'">
          <input v-model="choice" type="radio" name="pool-type" :value="x.id" :disabled="x.off" class="radio radio-sm mt-0.5">
          <span class="min-w-0">
            <span class="flex flex-wrap items-center gap-2 text-sm font-semibold text-base-content">{{ t(`ui.storage.Pools.type.${x.id}`) }}<TypeBadge :type="x.id" /></span>
            <span class="mt-0.5 block text-xs text-base-content/70">{{ x.off ? x.why : t(`ui.storage.Pools.typeHint.${x.id}`) }}</span>
          </span>
        </label>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="outline" @click="choosing = false">{{ t('ui.storage.PhysicalDisksSection.cancel') }}</Button>
          <Button :disabled="TYPES.find(x => x.id === choice)?.off" @click="startCreate">{{ t('ui.storage.Pools.continue') }}</Button>
        </div>
      </div>
    </Modal>
    <CreatePoolDialog v-if="creating === 'zfs'" :free-disks="freeDisks" :taken="zfs?.pools.map(p => p.name) ?? []"
      @close="creating = null" @created="name => created({ kind: 'pool', name })" />
    <RaidSection v-if="creating === 'md'" wizard :preselect="picked" @closed="created()" @navigate="l => typeof l === 'object' && created(l)" />
    <LvmSection v-if="creating === 'lvm'" wizard :preselect="picked" @closed="created()" @navigate="l => created(l)" />
  </div>
</template>
