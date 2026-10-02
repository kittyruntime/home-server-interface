<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import { usePageRefresh } from './page-refresh'
import ObjectPage, { type ObjectTab } from './ObjectPage.vue'
import ActivityList from './ActivityList.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'
import { useStorageData, fmtBytes, type BlockDev } from './store'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { volumeTargets } from './object-targets'
import { applyPlanned } from '../../lib/plan'
import { useAuth } from '../../lib/auth'

// The page of one volume (#40): where the data lives, what it is made of,
// what uses it, and what was done to it.

const props = defineProps<{ id: string }>()
const emit = defineEmits<{
  navigate: [target: StorageSection | StorageLocation]
  named: [name: string]
}>()

type Overview = Awaited<ReturnType<typeof trpc.storage.volumes.overview.query>>
type Volume = Overview['volumes'][number]

const volume  = ref<Volume | null>(null)
const loading = ref(true)
const error   = ref('')
const gone    = ref(false)
const tab     = ref<ObjectTab>('overview')
const { devices, refresh: refreshDevices } = useStorageData({ autoRefresh: false })
const { isAdmin } = useAuth()

// Remove volume (#40): one plan for its shares, its stack and its Places.
const removeError = ref('')
async function removeVolume() {
  const v = volume.value
  if (!v) return
  removeError.value = ''
  try {
    await applyPlanned('volume.remove', { id: v.id }, {
      domain: 'volume', title: `Remove the volume ${v.name}`, actionLabel: 'Remove volume', danger: true, confirmText: v.name,
    })
    emit('navigate', 'volumes')
  } catch (e) {
    removeError.value = e instanceof Error ? e.message : String(e)
  }
}

async function load() {
  error.value = ''
  try {
    const o = await trpc.storage.volumes.overview.query()
    // A volume keeps its page when its id changes (formatted again, or a
    // missing volume that came back): found again by its mount point.
    const was = volume.value
    volume.value = o.volumes.find(v => v.id === props.id)
      ?? (was?.mountPoint || was?.expectedMountPoint
        ? o.volumes.find(v => (v.mountPoint ?? v.expectedMountPoint) === (was.mountPoint ?? was.expectedMountPoint)) ?? null
        : null)
    gone.value = !volume.value
    if (volume.value) emit('named', volume.value.name)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not read the volume'
  } finally {
    loading.value = false
  }
}
watch(() => props.id, () => { loading.value = true; tab.value = 'overview'; void load() }, { immediate: true })

const REDUNDANCY: Record<string, string> = {
  none: 'No redundancy', raid0: 'Striped, no redundancy', raid1: 'Mirror',
  raid4: 'RAID 4', raid5: 'RAID 5', raid6: 'RAID 6', raid10: 'RAID 10',
}
const LAYER: Record<string, string> = {
  filesystem: 'Folder', lv: 'Logical volume', vg: 'Volume group', array: 'RAID array', partition: 'Partition', disk: 'Disk',
}

const health = computed(() => {
  const v = volume.value
  if (!v) return { cls: '', text: '' }
  if (v.state === 'missing') return { cls: 'text-danger', dot: 'bg-danger', text: 'Missing' }
  const bad = v.issues.find(i => i.kind === 'degraded' || i.kind === 'blocked')
  if (bad) return { cls: 'text-danger', dot: 'bg-danger', text: bad.text }
  if (v.issues.length) return { cls: 'text-warning', dot: 'bg-warning', text: v.issues[0]!.text }
  if (v.state === 'not-mounted') return { cls: 'text-[var(--c-text-3)]', dot: 'bg-[var(--c-text-3)]', text: 'Not mounted' }
  return { cls: 'text-[var(--c-text-2)]', dot: 'bg-success', text: 'Healthy' }
})
const usedPct = computed(() => volume.value?.space ? Math.round((volume.value.space.used / volume.value.space.total) * 100) : 0)

// Audit targets naming this volume. The last mount point seen is kept: an
// unmount clears it from the volume but is logged under it.
const lastMount = ref<string | undefined>()
watch(() => volume.value?.mountPoint, mp => { if (mp) lastMount.value = mp }, { immediate: true })
const targets = computed(() => volume.value ? volumeTargets(volume.value, lastMount.value) : [])

// Keep the page current while it is open (a disk can be unplugged, the
// missing-volume guard can unmount a volume).
usePageRefresh(load)

function openLayer(kind: string, name: string) {
  // A partition opens its disk's page (which resolves it).
  if (kind === 'disk' || kind === 'partition') emit('navigate', { kind: 'disk', name })
  else if (kind === 'array') emit('navigate', { kind: 'array', name })
  else if (kind === 'vg') emit('navigate', { kind: 'vg', name })
  else if (kind === 'lv') {
    const vg = volume.value?.stack.find(l => l.kind === 'vg')?.name
    emit('navigate', vg ? { kind: 'vg', name: vg } : 'lvm')
  }
}

async function device(): Promise<BlockDev | undefined> {
  if (!devices.value.length) await refreshDevices()
  const find = (list: BlockDev[]): BlockDev | undefined => {
    for (const d of list) {
      if (d.name === volume.value?.device) return d
      const c = find(d.children ?? [])
      if (c) return c
    }
    return undefined
  }
  return find(devices.value)
}
const mountDlg  = ref<InstanceType<typeof DeviceMountDialog> | null>(null)
const umountDlg = ref<InstanceType<typeof DeviceUnmountDialog> | null>(null)
// The device may have gone since the page loaded: reload instead of doing
// nothing.
async function mount()   { const d = await device(); if (d) mountDlg.value?.open(d); else void load() }
async function unmount() { const d = await device(); if (d) umountDlg.value?.open(d); else void load() }
async function afterChange() { await refreshDevices(); await load() }
</script>

<template>
  <ObjectPage
    v-model:tab="tab"
    :title="volume?.name ?? ''"
    :subtitle="volume ? (volume.mountPoint ?? `/dev/${volume.device}`) : ''"
    :loading="loading"
    :error="error"
    :gone="gone ? { text: 'This volume is no longer there.', back: 'Back to Volumes' } : undefined"
    @back="emit('navigate', 'volumes')"
  >
    <template v-if="volume" #chips>
      <span class="badge badge-muted">{{ REDUNDANCY[volume.redundancy] }}</span>
      <span class="inline-flex items-center gap-1.5 text-xs" :class="health.cls">
        <span class="w-1.5 h-1.5 rounded-full" :class="health.dot" />{{ health.text }}
      </span>
    </template>

    <template v-if="volume" #figure>
      <div v-if="volume.space" class="max-w-md">
        <div class="flex items-baseline gap-2">
          <span class="font-figure font-bold text-2xl tabular-nums text-[var(--c-text-1)]">{{ fmtBytes(volume.space.used) }}</span>
          <span class="text-xs text-[var(--c-text-3)]">used of {{ fmtBytes(volume.space.total) }} · {{ fmtBytes(volume.space.free) }} free</span>
        </div>
        <div class="mt-2 h-1.5 rounded-full bg-[var(--c-hover)] overflow-hidden">
          <div class="h-full rounded-full" :class="usedPct > 90 ? 'bg-warning' : 'bg-[var(--c-text-1)]'" :style="{ width: `${usedPct}%` }" />
        </div>
      </div>
    </template>

    <template v-if="volume" #actions>
      <button v-if="volume.state === 'not-mounted'" class="btn btn-primary btn-sm" @click="mount">Mount</button>
      <button v-else-if="volume.state === 'mounted'" class="btn btn-outline btn-sm" @click="unmount">Unmount</button>
    </template>

    <template v-if="volume" #overview>
      <div class="space-y-4">
        <div v-if="volume.state === 'missing'" class="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-[var(--c-text-1)]">
          HSI mounts this volume at <span class="font-mono">{{ volume.mountPoint }}</span>, but its disk was not found at boot. Apps and shares using it are stopped so nothing writes to the system disk in its place.
          <button class="ml-1 underline underline-offset-2" @click="emit('navigate', 'mounts')">Open Mounts</button>
        </div>
        <ul v-else-if="volume.issues.length" class="space-y-1.5">
          <li v-for="(i, n) in volume.issues" :key="n" class="status-text" :class="i.kind === 'degraded' || i.kind === 'blocked' ? 'text-danger' : 'text-warning'">
            <span class="status-tag">{{ i.kind === 'degraded' || i.kind === 'blocked' ? '[ERR]' : '[WARN]' }}</span> {{ i.text }}
          </li>
        </ul>

        <div>
          <h3 class="eyebrow mb-2">Used by</h3>
          <dl class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] divide-y divide-[var(--c-border)] text-sm">
            <div class="flex gap-4 px-4 py-2.5"><dt class="w-20 shrink-0 text-[var(--c-text-3)]">Places</dt><dd class="text-[var(--c-text-1)]">{{ volume.usedBy.places.map(p => p.name).join(', ') || '-' }}</dd></div>
            <div class="flex gap-4 px-4 py-2.5"><dt class="w-20 shrink-0 text-[var(--c-text-3)]">Shares</dt><dd class="font-mono text-xs text-[var(--c-text-1)] self-center">{{ volume.usedBy.shares.join(', ') || '-' }}</dd></div>
            <div class="flex gap-4 px-4 py-2.5"><dt class="w-20 shrink-0 text-[var(--c-text-3)]">Apps</dt><dd class="text-[var(--c-text-1)]">{{ volume.usedBy.apps.join(', ') || '-' }}</dd></div>
          </dl>
        </div>

        <p class="text-xs text-[var(--c-text-3)]">
          <span v-if="volume.fstype" class="font-mono">{{ volume.fstype }}</span>
          <template v-if="volume.tolerates"> · survives {{ volume.tolerates }} failed {{ volume.tolerates === 1 ? 'disk' : 'disks' }}</template>
          <template v-else-if="volume.state !== 'missing'"> · a failed disk loses this volume</template>
        </p>

        <section v-if="isAdmin && volume.state !== 'missing'" class="rounded-xl border border-danger/30 px-4 py-3">
          <h3 class="text-sm font-semibold text-danger">Remove this volume</h3>
          <p class="mt-1 text-xs text-[var(--c-text-2)]">
            Erases <template v-if="volume.space">the {{ fmtBytes(volume.space.used) }} it holds</template><template v-else>its data</template>. Disks used only by this volume become free again; the review lists them.
            <template v-if="volume.usedBy.places.length">Its Places and their shares are deleted.</template>
          </p>
          <p v-if="volume.usedBy.apps.length" class="mt-2 status-text text-warning">
            <span class="status-tag">[WARN]</span> {{ volume.usedBy.apps.join(', ') }} {{ volume.usedBy.apps.length === 1 ? 'stores' : 'store' }} data here: remove {{ volume.usedBy.apps.length === 1 ? 'it' : 'them' }} first.
          </p>
          <p v-if="removeError" role="alert" class="mt-2 status-text text-danger"><span class="status-tag">[ERR]</span> {{ removeError }}</p>
          <button class="btn btn-danger btn-sm mt-3" :disabled="volume.usedBy.apps.length > 0" @click="removeVolume">Remove volume…</button>
        </section>
      </div>
    </template>

    <template v-if="volume" #structure>
      <p v-if="!volume.stack.length" class="text-sm text-[var(--c-text-3)]">The devices of this volume are not connected.</p>
      <ol v-else class="space-y-1.5 max-w-lg">
        <li v-for="(layer, i) in volume.stack" :key="`${layer.kind}:${layer.name}`">
          <component
            :is="layer.kind === 'filesystem' ? 'div' : 'button'"
            :class="['w-full flex items-center justify-between gap-3 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] px-3 py-2 text-left text-sm',
              layer.kind !== 'filesystem' && 'hover:border-[var(--c-border-strong)] transition-colors']"
            @click="layer.kind !== 'filesystem' && openLayer(layer.kind, layer.name)"
          >
            <span class="text-[var(--c-text-3)] text-xs w-28 shrink-0">{{ LAYER[layer.kind] }}</span>
            <span class="flex-1 min-w-0 truncate font-mono text-xs text-[var(--c-text-1)]">{{ layer.name }}</span>
            <span v-if="layer.kind !== 'filesystem'" aria-hidden="true" class="text-[var(--c-text-3)]">→</span>
          </component>
          <div v-if="i < volume.stack.length - 1 && volume.stack[i + 1]!.kind !== layer.kind" aria-hidden="true" class="pl-4 text-xs leading-4 text-[var(--c-text-3)]">↓</div>
        </li>
      </ol>
    </template>

    <template v-if="volume" #activity>
      <ActivityList :targets="targets" />
    </template>
  </ObjectPage>

  <DeviceMountDialog ref="mountDlg" @done="afterChange" />
  <DeviceUnmountDialog ref="umountDlg" @done="afterChange" />
</template>
