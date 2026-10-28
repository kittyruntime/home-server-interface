<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import { usePageRefresh } from './page-refresh'
import ObjectPage, { type ObjectTab } from './ObjectPage.vue'
import ActivityList from './ActivityList.vue'
import RaidSection from './RaidSection.vue'
import { useStorageData, fmtBytes, type BlockDev } from './store'
import { arrayTargets } from './object-targets'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { Button } from '@/components/ui/button'
import { Item } from '@/components/ui/item'

// The page of one RAID array (#40): its state and members, what it carries,
// and what was done to it. The Overview is the RAID section limited to it.

const props = defineProps<{ name: string }>()
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation] }>()

const { loading, loaded, error, devices, raids, lvmPVs, refresh } = useStorageData()
usePageRefresh(refresh)
const tab = ref<ObjectTab>('overview')
watch(() => props.name, () => { tab.value = 'overview' })

const array = computed(() => raids.value.find(r => r.name === props.name) ?? null)
const LEVEL: Record<string, string> = { raid0: 'Striped', raid1: 'Mirror', raid4: 'RAID 4', raid5: 'RAID 5', raid6: 'RAID 6', raid10: 'RAID 10' }

const state = computed(() => {
  const a = array.value
  if (!a) return { cls: '', dot: '', text: '' }
  const syncing = a.syncAction && ['recovery', 'resync', 'reshape', 'check'].includes(a.syncAction) && a.resyncPercent != null
  if (a.active < a.total && syncing) return { cls: 'text-warning', dot: 'bg-warning', text: `Rebuilding ${Math.round(a.resyncPercent!)}%` }
  if (a.active < a.total) return { cls: 'text-destructive', dot: 'bg-destructive', text: `Degraded: ${a.total - a.active} of ${a.total} missing` }
  if (syncing) return { cls: 'text-warning', dot: 'bg-warning', text: `${a.syncAction === 'check' ? 'Checking' : 'Resyncing'} ${Math.round(a.resyncPercent!)}%` }
  return { cls: 'text-foreground/80', dot: 'bg-success', text: 'Healthy' }
})

function findDev(list: BlockDev[], name: string): BlockDev | undefined {
  for (const d of list) {
    if (d.name === name) return d
    const c = findDev(d.children ?? [], name)
    if (c) return c
  }
  return undefined
}
const size = computed(() => findDev(devices.value, props.name)?.size ?? 0)
const members = computed(() => array.value?.devices ?? [])
const vg = computed(() => lvmPVs.value.find(p => p.name === `/dev/${props.name}`)?.vgName)

// Volumes built on this array.
const volumes = ref<Array<{ id: string; name: string; mountPoint?: string }>>([])
// Reloaded when the store changes, so actions taken on this page show up.
watch([() => props.name, devices], async ([n]) => {
  try {
    const o = await trpc.storage.volumes.overview.query()
    if (n !== props.name) return
    volumes.value = o.volumes.filter(v => v.stack.some(l => l.kind === 'array' && l.name === n))
      .map(v => ({ id: v.id, name: v.name, mountPoint: v.mountPoint }))
  } catch { volumes.value = [] }
}, { immediate: true })

const targets = computed(() => arrayTargets({ name: props.name, mountPoint: findDev(devices.value, props.name)?.mountpoint || undefined }))
</script>

<template>
  <ObjectPage
    v-model:tab="tab"
    :title="`/dev/${name}`"
    :subtitle="array ? `${array.active} of ${array.total} disks` : ''"
    :loading="!loaded && !error"
    :error="error && !array ? error : ''"
    :gone="loaded && !loading && !array ? { text: 'This array is no longer assembled.', back: 'Back to Arrays' } : undefined"
    @back="emit('navigate', 'raid')"
  >
    <template v-if="array" #chips>
      <span class="text-2xs px-1.5 py-0.5 rounded-sm border border-border bg-muted text-foreground/80">{{ LEVEL[array.level] ?? array.level }}</span>
      <span class="inline-flex items-center gap-1.5 text-xs" :class="state.cls"><span class="w-1.5 h-1.5 rounded-full" :class="state.dot" />{{ state.text }}</span>
    </template>
    <template v-if="array && size" #figure>
      <span class="font-figure font-bold text-2xl tabular-nums text-foreground">{{ fmtBytes(size) }}</span>
    </template>

    <template #actions>
      <Button variant="ghost" size="sm" :disabled="loading" @click="refresh">Refresh</Button>
    </template>

    <template v-if="array" #overview>
      <RaidSection :only="name" @navigate="t => emit('navigate', t)" />
    </template>

    <template v-if="array" #structure>
      <div class="space-y-4 max-w-lg">
        <div>
          <h3 class="eyebrow mb-2">On this array</h3>
          <p v-if="!volumes.length && !vg" class="text-sm text-muted-foreground">Nothing yet.</p>
          <ul class="space-y-1.5">
            <li v-if="vg">
              <Item as="button" variant="outline" size="sm" class="w-full flex-nowrap justify-between gap-3 bg-card px-3 py-2 hover:bg-accent/50" @click="emit('navigate', { kind: 'vg', name: vg })">
                <span class="text-xs text-muted-foreground w-28 shrink-0 text-left">Volume group</span><span class="flex-1 text-left font-mono text-xs">{{ vg }}</span><span aria-hidden="true" class="text-muted-foreground">→</span>
              </Item>
            </li>
            <li v-for="v in volumes" :key="v.id">
              <Item as="button" variant="outline" size="sm" class="w-full flex-nowrap justify-between gap-3 bg-card px-3 py-2 hover:bg-accent/50" @click="emit('navigate', { kind: 'volume', id: v.id })">
                <span class="text-xs text-muted-foreground w-28 shrink-0 text-left">Volume</span><span class="flex-1 text-left">{{ v.name }} <span v-if="v.mountPoint" class="font-mono text-xs text-muted-foreground">{{ v.mountPoint }}</span></span><span aria-hidden="true" class="text-muted-foreground">→</span>
              </Item>
            </li>
          </ul>
        </div>
        <div>
          <h3 class="eyebrow mb-2">Members</h3>
          <ul class="space-y-1.5">
            <li v-for="m in members" :key="m">
              <Item as="button" variant="outline" size="sm" class="w-full flex-nowrap justify-between gap-3 bg-card px-3 py-2 hover:bg-accent/50" @click="emit('navigate', { kind: 'disk', name: m })">
                <span class="text-xs text-muted-foreground w-28 shrink-0 text-left">Member</span><span class="flex-1 text-left font-mono text-xs">{{ m }}</span><span aria-hidden="true" class="text-muted-foreground">→</span>
              </Item>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <template v-if="array" #activity>
      <ActivityList :targets="targets" :arrays="[name]" />
    </template>
  </ObjectPage>
</template>
