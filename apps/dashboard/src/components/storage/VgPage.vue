<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import ObjectPage, { type ObjectTab } from './ObjectPage.vue'
import ActivityList from './ActivityList.vue'
import LvmSection from './LvmSection.vue'
import { useStorageData, fmtBytes } from './store'
import { vgTargets } from './object-targets'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'

// The page of one LVM volume group (#40): its space, its logical volumes and
// what they carry, its physical volumes, and what was done to it. The
// Overview is the LVM section limited to it.

const props = defineProps<{ name: string }>()
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation] }>()

const { loading, loaded, error, raids, lvmVGs, lvmLVs, lvmPVs } = useStorageData()
const tab = ref<ObjectTab>('overview')
watch(() => props.name, () => { tab.value = 'overview' })

const vg  = computed(() => lvmVGs.value.find(v => v.name === props.name) ?? null)
const lvs = computed(() => lvmLVs.value.filter(l => l.vgName === props.name))
const pvs = computed(() => lvmPVs.value.filter(p => p.vgName === props.name))

// What each logical volume carries.
const volumeOf = ref<Record<string, { id: string; name: string; mountPoint?: string }>>({})
watch(() => props.name, async n => {
  try {
    const o = await trpc.storage.volumes.overview.query()
    if (n !== props.name) return
    const map: typeof volumeOf.value = {}
    for (const v of o.volumes) {
      const lv = v.stack.find(l => l.kind === 'lv')?.name
      const g  = v.stack.find(l => l.kind === 'vg')?.name
      if (lv && g === n) map[lv] = { id: v.id, name: v.name, mountPoint: v.mountPoint }
    }
    volumeOf.value = map
  } catch { volumeOf.value = {} }
}, { immediate: true })

// A PV is an array (md0) or a disk or partition.
function openPv(pvName: string) {
  const dev = pvName.replace(/^\/dev\//, '')
  if (raids.value.some(r => r.name === dev)) emit('navigate', { kind: 'array', name: dev })
  else emit('navigate', { kind: 'disk', name: dev })
}

const targets = computed(() => vgTargets({ name: props.name, lvs: lvs.value.map(l => l.name) }))
</script>

<template>
  <ObjectPage
    v-model:tab="tab"
    :title="name"
    :subtitle="vg ? `${vg.pvCount} physical ${vg.pvCount === 1 ? 'volume' : 'volumes'} · ${vg.lvCount} logical ${vg.lvCount === 1 ? 'volume' : 'volumes'}` : ''"
    :loading="!loaded && !error"
    :error="error && !vg ? error : ''"
    :gone="loaded && !loading && !vg ? { text: 'This volume group is no longer there.', back: 'Back to Volume groups' } : undefined"
    @back="emit('navigate', 'lvm')"
  >
    <template v-if="vg" #chips>
      <span class="text-2xs px-1.5 py-0.5 rounded-sm border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-2)]">Volume group</span>
    </template>
    <template v-if="vg" #figure>
      <div class="flex items-baseline gap-2">
        <span class="font-figure font-bold text-2xl tabular-nums text-[var(--c-text-1)]">{{ fmtBytes(vg.size) }}</span>
        <span class="text-xs text-[var(--c-text-3)]">{{ vg.free > 0 ? `${fmtBytes(vg.free)} free` : "no free space" }}</span>
      </div>
    </template>

    <template v-if="vg" #overview>
      <LvmSection :only="name" @navigate="t => emit('navigate', t)" />
    </template>

    <template v-if="vg" #structure>
      <div class="space-y-4 max-w-lg">
        <div>
          <h3 class="eyebrow mb-2">Logical volumes</h3>
          <p v-if="!lvs.length" class="text-sm text-[var(--c-text-3)]">None yet.</p>
          <ul class="space-y-1.5">
            <li v-for="lv in lvs" :key="lv.name">
              <component :is="volumeOf[lv.name] ? 'button' : 'div'"
                :class="['w-full flex items-center justify-between gap-3 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] px-3 py-2 text-sm text-left', volumeOf[lv.name] && 'hover:border-[var(--c-border-strong)] transition-colors']"
                @click="volumeOf[lv.name] && emit('navigate', { kind: 'volume', id: volumeOf[lv.name]!.id })">
                <span class="font-mono text-xs w-28 shrink-0 truncate">{{ lv.name }}</span>
                <span class="flex-1 min-w-0 truncate text-[var(--c-text-2)]">{{ volumeOf[lv.name] ? volumeOf[lv.name]!.name : 'No filesystem' }} <span v-if="volumeOf[lv.name]?.mountPoint" class="font-mono text-xs text-[var(--c-text-3)]">{{ volumeOf[lv.name]!.mountPoint }}</span></span>
                <span class="tabular-nums text-xs text-[var(--c-text-3)] shrink-0">{{ fmtBytes(lv.size) }}</span>
                <span v-if="volumeOf[lv.name]" aria-hidden="true" class="text-[var(--c-text-3)]">→</span>
              </component>
            </li>
          </ul>
        </div>
        <div>
          <h3 class="eyebrow mb-2">Physical volumes</h3>
          <ul class="space-y-1.5">
            <li v-for="pv in pvs" :key="pv.name">
              <button class="w-full flex items-center justify-between gap-3 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] px-3 py-2 text-sm hover:border-[var(--c-border-strong)] transition-colors" @click="openPv(pv.name)">
                <span class="font-mono text-xs flex-1 text-left">{{ pv.name }}</span>
                <span class="tabular-nums text-xs text-[var(--c-text-3)]">{{ fmtBytes(pv.size) }}</span>
                <span aria-hidden="true" class="text-[var(--c-text-3)]">→</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <template v-if="vg" #activity>
      <ActivityList :targets="targets" />
    </template>
  </ObjectPage>
</template>
