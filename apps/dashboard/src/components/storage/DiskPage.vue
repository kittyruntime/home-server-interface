<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ref, computed, watch, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { usePageRefresh } from './page-refresh'
import ObjectPage, { type ObjectTab } from './ObjectPage.vue'
import ActivityList from './ActivityList.vue'
import DiskCard from './DiskCard.vue'
import DiskLabel from './DiskLabel.vue'
import DeviceFormatWizard from './dialogs/DeviceFormatWizard.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'
import { useStorageData, fmtBytes, type BlockDev } from './store'
import { type SmartResult, smartStatus, fetchSmartInto } from './smart'
import { diskRow, ROLE_LABELS } from './disk-list'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { Badge } from '@/components/ui/badge'

const { t } = useI18n()

// The page of one physical disk (#40): what it is, how healthy it is, what it
// carries, and what was done to it.

const props = defineProps<{ name: string }>()
const emit = defineEmits<{ navigate: [target: StorageSection | StorageLocation]; named: [name: string] }>()

const { loading, loaded, error, devices, lvmLVs, refresh } = useStorageData()
const tab = ref<ObjectTab>('overview')
onMounted(() => { void refresh() })

// Keep the page current while it is open (a disk can be unplugged, the
// missing-volume guard can unmount a volume).
usePageRefresh(refresh)
watch(() => props.name, () => { tab.value = 'overview' })

// A link may name a partition (an array member like sdc1): show its disk.
const disk = computed(() => devices.value.find(d => d.type === 'disk'
  && (d.name === props.name || (d.children ?? []).some(c => c.name === props.name))) ?? null)
const diskName = computed(() => disk.value?.name ?? props.name)
// The crumb shows the disk, also when the link named a partition.
watch(diskName, n => emit('named', n), { immediate: true })

// SMART: the full read, since the admin opened this disk.
const smart = ref<Record<string, SmartResult>>({})
const smartOpen = ref(false)
watch(diskName, n => { void fetchSmartInto(smart, n) }, { immediate: true })
const sm = computed(() => smart.value[diskName.value])
const health = computed(() => {
  const st = smartStatus(sm.value)
  if (st === 'failed')  return { cls: 'text-destructive', dot: 'bg-destructive', text: 'SMART failed' }
  if (st === 'warning') return { cls: 'text-warning', dot: 'bg-warning', text: 'SMART warning' }
  if (st === 'passed')  return { cls: 'text-foreground/80', dot: 'bg-success', text: 'Healthy' }
  return { cls: 'text-muted-foreground', dot: 'bg-muted-foreground', text: st === 'loading' ? 'Reading SMART' : 'Health unknown' }
})
const criticalAttrs = computed(() => (sm.value?.attributes ?? []).filter(a => a.isCritical && a.raw > 0))

const labels = ref<Record<string, string>>({})
void trpc.storage.diskLabels.list.query()
  .then(ls => { labels.value = Object.fromEntries(ls.map(l => [l.serial, l.label])) })
  .catch(() => {})
const label = computed(() => (disk.value?.serial && labels.value[disk.value.serial]) || '')

const row = computed(() => disk.value
  ? diskRow(disk.value, sm.value ? { health: 'unknown', rotationRate: sm.value.rotationRate, available: sm.value.available } : undefined, label.value)
  : null)
const roleText = computed(() => {
  const r = row.value
  if (!r) return ''
  if (r.role === 'raid') return r.raidOwners.length ? `RAID ${r.raidOwners.join(', ')}` : 'RAID member (inactive)'
  if (r.role === 'lvm')  return r.vgOwners.length ? `VG ${r.vgOwners.join(', ')}` : 'LVM member (no VG)'
  return ROLE_LABELS[r.role]
})
function openOwner() {
  const r = row.value
  if (r?.role === 'raid') emit('navigate', r.raidOwners[0] ? { kind: 'array', name: r.raidOwners[0] } : 'raid')
  else if (r?.role === 'lvm') emit('navigate', r.vgOwners[0] ? { kind: 'vg', name: r.vgOwners[0] } : 'lvm')
}

// Volumes this disk carries.
const volumes = ref<Array<{ id: string; name: string; mountPoint?: string }>>([])
watch([diskName, devices], async ([n]) => {
  try {
    const o = await trpc.storage.volumes.overview.query()
    if (n !== diskName.value) return // a later request owns the list
    volumes.value = o.volumes.filter(v => v.disks.some(d => d.name === n))
      .map(v => ({ id: v.id, name: v.name, mountPoint: v.mountPoint }))
  } catch { volumes.value = [] }
}, { immediate: true })

const targets = computed(() => {
  const d = disk.value
  if (!d) return [diskName.value, `/dev/${diskName.value}`]
  const parts = (d.children ?? []).flatMap(c => [c.name, `/dev/${c.name}`])
  return [d.name, `/dev/${d.name}`, ...parts].slice(0, 20)
})

const formatWiz = ref<InstanceType<typeof DeviceFormatWizard> | null>(null)
const mountDlg  = ref<InstanceType<typeof DeviceMountDialog> | null>(null)
const umountDlg = ref<InstanceType<typeof DeviceUnmountDialog> | null>(null)
function manageInDevices() { emit('navigate', 'disks') }
</script>

<template>
  <ObjectPage
    v-model:tab="tab"
    :title="`/dev/${diskName}`"
    :subtitle="disk ? [disk.model, disk.serial].filter(Boolean).join(' · ') : ''"
    :loading="!loaded && !error"
    :error="error && !disk ? error : ''"
    :gone="loaded && !loading && !disk ? { text: 'This disk is no longer connected.', back: 'Back to Disks' } : undefined"
    @back="emit('navigate', 'disks')"
  >
    <template v-if="disk && row" #chips>
      <Button variant="outline" size="xs" v-if="row.role === 'raid' || row.role === 'lvm'" class="text-2xs bg-muted text-foreground/80 hover:text-foreground" @click="openOwner">{{ roleText }} →</Button>
      <span v-else class="text-2xs px-1.5 py-0.5 rounded-sm border border-border bg-muted text-foreground/80">{{ roleText }}</span>
      <Badge variant="secondary" v-if="row.kind">{{ row.kind }}</Badge>
      <span class="inline-flex items-center gap-1.5 text-xs" :class="health.cls">
        <span class="w-1.5 h-1.5 rounded-full" :class="health.dot" />{{ health.text }}
      </span>
    </template>

    <template v-if="disk" #figure>
      <div class="flex items-baseline gap-3">
        <span class="font-figure font-bold text-2xl tabular-nums text-foreground">{{ fmtBytes(disk.size) }}</span>
        <DiskLabel class="max-w-xs" :serial="disk.serial" :label="label"
          @saved="l => { if (disk?.serial) labels = { ...labels, [disk.serial]: l } }" />
      </div>
    </template>

    <template v-if="disk" #overview>
      <div class="space-y-4">
        <p v-if="error" role="alert" class="status-text text-warning"><span class="status-tag">[WARN]</span> Could not refresh this disk: {{ error }}. What is shown may be out of date.</p>
        <dl class="rounded-xl border border-border bg-card divide-y divide-border text-sm">
          <div class="flex gap-4 px-4 py-2.5"><dt class="w-24 shrink-0 text-muted-foreground">{{ t('ui.storage.DiskPage.model') }}</dt><dd class="text-foreground">{{ disk.model || '-' }}</dd></div>
          <div class="flex gap-4 px-4 py-2.5"><dt class="w-24 shrink-0 text-muted-foreground">{{ t('ui.storage.DiskPage.serial') }}</dt><dd class="font-mono text-xs self-center text-foreground">{{ disk.serial || '-' }}</dd></div>
          <div class="flex gap-4 px-4 py-2.5"><dt class="w-24 shrink-0 text-muted-foreground">WWN</dt><dd class="font-mono text-xs self-center text-foreground">{{ disk.wwn || '-' }}</dd></div>
          <div class="flex gap-4 px-4 py-2.5"><dt class="w-24 shrink-0 text-muted-foreground">{{ t('ui.storage.DiskPage.stableName') }}</dt><dd class="font-mono text-xs self-center text-foreground break-all">{{ disk.byId ? `/dev/disk/by-id/${disk.byId}` : '-' }}</dd></div>
        </dl>

        <div>
          <h3 class="eyebrow mb-2">{{ t('ui.storage.DiskPage.health') }}</h3>
          <Card class="block gap-0 py-0 shadow-none px-4 py-3 text-sm space-y-1.5">
            <p :class="health.cls">{{ health.text }}</p>
            <p v-if="sm && sm.available" class="text-xs text-muted-foreground">
              <span v-if="sm.temperature" class="tabular-nums">{{ sm.temperature }}°C · </span>
              <span class="tabular-nums">{{ sm.powerOnHours.toLocaleString() }} hours powered on</span>
            </p>
            <ul v-if="criticalAttrs.length" class="space-y-1">
              <li v-for="a in criticalAttrs" :key="a.id" class="status-text text-warning"><span class="status-tag">[WARN]</span> {{ a.name }}: {{ a.raw }}</li>
            </ul>
            <Button variant="link" class="h-auto p-0 text-muted-foreground hover:text-foreground" @click="smartOpen = true; tab = 'structure'">
              {{ t('ui.storage.DiskPage.showSmartDetails') }}
            </Button>
          </Card>
        </div>

        <div>
          <h3 class="eyebrow mb-2">{{ t('ui.storage.DiskPage.volumesOnThisDisk') }}</h3>
          <p v-if="!volumes.length" class="text-sm text-muted-foreground">{{ t('ui.storage.DiskPage.none') }}</p>
          <ul v-else class="flex flex-wrap gap-2">
            <li v-for="v in volumes" :key="v.id">
              <Button variant="outline" size="sm" @click="emit('navigate', { kind: 'volume', id: v.id })">
                {{ v.name }} <span v-if="v.mountPoint" class="font-mono text-xs text-muted-foreground">{{ v.mountPoint }}</span> →
              </Button>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <template v-if="disk" #structure>
      <DiskCard :disk="disk" :smart="sm" :smart-open="smartOpen" :devices="devices" :lvs="lvmLVs"
        @navigate="s => emit('navigate', s)" @toggle-smart="smartOpen = !smartOpen"
        @format="(d: BlockDev) => formatWiz?.open(d)" @mount="(d: BlockDev) => mountDlg?.open(d)" @umount="(d: BlockDev) => umountDlg?.open(d)"
        @part-init="manageInDevices" @part-create="manageInDevices" @part-delete="manageInDevices" />
      <p class="mt-2 text-xs text-muted-foreground">{{ t('ui.storage.DiskPage.partitionTablesAndPartitionsAre') }} <Button variant="link" class="h-auto p-0 hover:text-foreground" @click="manageInDevices">{{ t('ui.storage.DiskPage.disks') }}</Button>.</p>
    </template>

    <template v-if="disk" #activity>
      <ActivityList :targets="targets" />
    </template>
  </ObjectPage>

  <DeviceFormatWizard ref="formatWiz" @done="refresh" />
  <DeviceMountDialog ref="mountDlg" @done="refresh" />
  <DeviceUnmountDialog ref="umountDlg" @done="refresh" />
</template>
