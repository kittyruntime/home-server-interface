<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { InfoIcon, RefreshCwIcon } from '@lucide/vue'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import LoadingState from '../ui/LoadingState.vue'
import Modal from '../ui/Modal.vue'
import type { StorageLocation } from '../../lib/storage-nav'
import { applyPlanned } from '../../lib/plan'
import { useStorageData, fmtBytes, type BlockDev } from './store'
import { fetchSmartInto, sharedSmart } from './smart'
import { diskRow, toolable } from './disk-list'
import DiskCard from './DiskCard.vue'
import DeviceFormatWizard from './dialogs/DeviceFormatWizard.vue'
import DeviceMountDialog from './dialogs/DeviceMountDialog.vue'
import DeviceUnmountDialog from './dialogs/DeviceUnmountDialog.vue'
import ConfirmDestroyDialog from './dialogs/ConfirmDestroyDialog.vue'

// LVM > Partitions & formatting: the disks no array, volume group, pool or
// the system uses, with the tools to partition, format, mount and unmount
// them. The Disks tab only shows hardware.
const emit = defineEmits<{ navigate: [target: 'pools' | StorageLocation] }>()
const { t } = useI18n()
const { loading, error, devices, lvmLVs, refresh } = useStorageData()

const smartCache = sharedSmart
const smartOpen  = ref<Set<string>>(new Set())

function toggleSmart(diskName: string) {
  const s = new Set(smartOpen.value)
  if (s.has(diskName)) { s.delete(diskName) } else {
    s.add(diskName)
    const c = smartCache.value[diskName]
    // Opening the panel is explicit: read a disk that was skipped in standby.
    if (!c || c._error || (!c.available && !c.unsupported && !c._loading)) fetchSmartInto(smartCache, diskName)
  }
  smartOpen.value = s
}

const disks = computed(() => devices.value.filter(d => d.type === 'disk' && toolable(diskRow(d))))

// ── Partition dialogs ─────────────────────────────────────────────────────────

const partInitDlg = ref<{ disk: BlockDev; busy: boolean; err: string } | null>(null)

async function doPartInit() {
  if (!partInitDlg.value) return
  const d = partInitDlg.value
  d.busy = true; d.err = ''
  try {
    await applyPlanned('part.init', { device: d.disk.name },
      { title: t('uis.storage.PhysicalDisksSection.newPartitionTableOnDev', { p0: d.disk.name }), actionLabel: t('uis.storage.PhysicalDisksSection.eraseDev', { p0: d.disk.name }) })
    partInitDlg.value = null
    await refresh()
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? t('uis.storage.PhysicalDisksSection.failedToInitialisePartitionTable')
  } finally {
    if (partInitDlg.value) d.busy = false
  }
}

const partCreateDlg = ref<{ disk: BlockDev; busy: boolean; err: string } | null>(null)

async function doPartCreate() {
  if (!partCreateDlg.value) return
  const d = partCreateDlg.value
  d.busy = true; d.err = ''
  try {
    await applyPlanned('part.create', { device: d.disk.name, startPct: 0, endPct: 100 },
      { title: t('uis.storage.PhysicalDisksSection.addAPartitionOnDev', { p0: d.disk.name }), actionLabel: t('uis.storage.PhysicalDisksSection.addPartition') })
    partCreateDlg.value = null
    await refresh()
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? t('uis.storage.PhysicalDisksSection.failedToCreatePartition')
  } finally {
    if (partCreateDlg.value) d.busy = false
  }
}

const partDeleteDlg = ref<{ disk: BlockDev; part: BlockDev; busy: boolean; err: string } | null>(null)

function partNumOf(diskName: string, partName: string): string {
  // sda1 → 1, nvme0n1p2 → 2
  const suffix = partName.replace(diskName, '')
  return suffix.replace(/^p/, '')
}

async function doPartDelete() {
  if (!partDeleteDlg.value) return
  const d = partDeleteDlg.value
  const num = partNumOf(d.disk.name, d.part.name)
  d.busy = true; d.err = ''
  try {
    await applyPlanned('part.delete', { device: d.disk.name, partNum: num },
      { title: t('uis.storage.PhysicalDisksSection.deletePartition', { p0: d.part.name }), actionLabel: t('uis.storage.PhysicalDisksSection.delete', { p0: d.part.name }) })
    partDeleteDlg.value = null
    await refresh()
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? t('uis.storage.PhysicalDisksSection.failedToDeletePartition')
  } finally {
    if (partDeleteDlg.value) d.busy = false
  }
}

// ── Format wizard ─────────────────────────────────────────────────────────────

// Device format/mount/unmount dialogs are shared components (see ./dialogs);
// these thin wrappers open them via template refs and refresh on success.
const formatWiz = ref<InstanceType<typeof DeviceFormatWizard> | null>(null)
const mountDlg  = ref<InstanceType<typeof DeviceMountDialog>  | null>(null)
const umountDlg = ref<InstanceType<typeof DeviceUnmountDialog> | null>(null)
function openFormat(dev: BlockDev) { formatWiz.value?.open(dev) }
function openMount(dev: BlockDev)  { mountDlg.value?.open(dev) }
function openUmount(dev: BlockDev) { umountDlg.value?.open(dev) }
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mb-4">
      <div class="min-w-0 flex-1 basis-56">
        <!-- Inside Disks, under the disks: a sub-heading. -->
        <h3 class="text-sm font-semibold text-base-content">{{ t('ui.storage.PartitionsSection.title') }}</h3>
        <p class="text-xs text-base-content/70 mt-0.5">{{ t('ui.storage.PartitionsSection.subtitle') }}</p>
      </div>
      <Button variant="ghost" size="icon-sm" @click="refresh" :disabled="loading" :tooltip="t('ui.storage.PhysicalDisksSection.refresh')" :aria-label="t('ui.storage.PhysicalDisksSection.refresh')" class="text-base-content/70 hover:text-base-content">
        <LoadingSpinner v-if="loading" class="text-base" />
        <RefreshCwIcon v-else class="w-4 h-4" aria-hidden="true" />
      </Button>
    </div>

    <LoadingState v-if="loading && !devices.length" variant="block" />
    <Alert variant="destructive" v-else-if="error" class="mt-4"><AlertDescription>{{ error }}</AlertDescription></Alert>
    <Card v-else-if="!disks.length" class="block gap-0 py-0 shadow-none px-4 py-8 text-center text-sm text-base-content/70">
      {{ t('ui.storage.PartitionsSection.none') }}
    </Card>
    <div v-else class="space-y-3">
      <DiskCard v-for="d in disks" :key="d.name" :disk="d" :smart="smartCache[d.name]" :smart-open="smartOpen.has(d.name)"
        :devices="devices" :lvs="lvmLVs"
        @navigate="s => emit('navigate', s)" @toggle-smart="toggleSmart(d.name)"
        @format="openFormat" @mount="openMount" @umount="openUmount"
        @part-init="dd => partInitDlg = { disk: dd, busy: false, err: '' }"
        @part-create="dd => partCreateDlg = { disk: dd, busy: false, err: '' }"
        @part-delete="(dd, p) => partDeleteDlg = { disk: dd, part: p, busy: false, err: '' }" />
    </div>

    <!-- Shared device dialogs (format / mount / unmount) -->
    <DeviceFormatWizard ref="formatWiz" @done="refresh" @mount="d => mountDlg?.open(d)" />
    <DeviceMountDialog ref="mountDlg" @done="refresh" />
    <DeviceUnmountDialog ref="umountDlg" @done="refresh" />

    <!-- Create partition table -->
    <ConfirmDestroyDialog
      v-if="partInitDlg"
      :title="t('ui.storage.PhysicalDisksSection.createPartitionTable')"
      subtitle="Writes a new GPT partition table: all existing data on the disk will be lost."
      :confirm-word="partInitDlg.disk.name"
      action-label="Create partition table"
      busy-label="Creating…"
      :busy="partInitDlg.busy"
      :error="partInitDlg.err"
      @confirm="doPartInit"
      @close="partInitDlg = null"
    >
      <template #warning>{{ t('ui.storage.PhysicalDisksSection.allPartitionsAndDataOn') }} <span class="font-bold">/dev/{{ partInitDlg.disk.name }}</span> {{ t('ui.storage.PhysicalDisksSection.willBePermanentlyDestroyedThis') }}</template>
      <template #details>
        <div class="flex gap-2"><span class="w-16 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.disk') }}</span><span class="font-mono">/dev/{{ partInitDlg.disk.name }}</span></div>
        <div class="flex gap-2"><span class="w-16 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.size') }}</span><span>{{ fmtBytes(partInitDlg.disk.size) }}</span></div>
        <div v-if="partInitDlg.disk.model" class="flex gap-2"><span class="w-16 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.model') }}</span><span>{{ partInitDlg.disk.model }}</span></div>
        <div v-if="partInitDlg.disk.serial" class="flex gap-2"><span class="w-16 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.serial') }}</span><span class="font-mono">{{ partInitDlg.disk.serial }}</span></div>
      </template>
    </ConfirmDestroyDialog>

    <!-- Add partition -->
    <Modal :label="t('ui.storage.PhysicalDisksSection.addPartition')" v-if="partCreateDlg" panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!partCreateDlg.busy" @close="partCreateDlg = null">
      <div class="px-5 py-4 border-b border-base-300">
        <h3 class="font-semibold text-base-content">{{ t('ui.storage.PhysicalDisksSection.addPartition') }}</h3>
        <p class="text-xs text-base-content/70 mt-0.5">{{ t('ui.storage.PhysicalDisksSection.createsANewPartitionSpanning') }} <span>/dev/{{ partCreateDlg.disk.name }}</span>.</p>
      </div>
      <div class="p-5 space-y-4">
        <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-base-200 border border-base-300 text-xs text-base-content/70">
          <InfoIcon class="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
          {{ t('ui.storage.PhysicalDisksSection.thePartitionWillUseThe') }}
        </div>
        <div class="space-y-1 text-xs text-base-content/70">
          <div class="flex gap-2"><span class="w-16 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.disk') }}</span><span class="font-mono">/dev/{{ partCreateDlg.disk.name }}</span></div>
          <div class="flex gap-2"><span class="w-16 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.diskSize') }}</span><span>{{ fmtBytes(partCreateDlg.disk.size) }}</span></div>
        </div>
        <p v-if="partCreateDlg.err" role="alert" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ partCreateDlg.err }}</p>
        <div class="flex gap-2 pt-1">
          <Button variant="outline" @click="partCreateDlg = null" class="flex-1 justify-center">{{ t('ui.storage.PhysicalDisksSection.cancel') }}</Button>
          <Button @click="doPartCreate" :disabled="partCreateDlg.busy"
            class="flex-1 justify-center">
            <span v-if="partCreateDlg.busy">{{ t('ui.storage.PhysicalDisksSection.creating') }}</span>
            <span v-else>{{ t('ui.storage.PhysicalDisksSection.createPartition') }}</span>
          </Button>
        </div>
      </div>
    </Modal>

    <!-- Delete partition -->
    <ConfirmDestroyDialog
      v-if="partDeleteDlg"
      :title="t('ui.storage.PhysicalDisksSection.deletePartition')"
      action-label="Delete partition"
      busy-label="Deleting…"
      :busy="partDeleteDlg.busy"
      :error="partDeleteDlg.err"
      @confirm="doPartDelete"
      @close="partDeleteDlg = null"
    >
      <template #warning>{{ t('ui.storage.PhysicalDisksSection.deleting') }} <span class="font-bold">/dev/{{ partDeleteDlg.part.name }}</span> {{ t('ui.storage.PhysicalDisksSection.willPermanentlyDestroyAllData') }}</template>
      <template #details>
        <div class="flex gap-2"><span class="w-20 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.partition') }}</span><span class="font-mono">/dev/{{ partDeleteDlg.part.name }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.size') }}</span><span>{{ fmtBytes(partDeleteDlg.part.size) }}</span></div>
        <div v-if="partDeleteDlg.part.fstype" class="flex gap-2"><span class="w-20 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.filesystem') }}</span><span class="font-mono">{{ partDeleteDlg.part.fstype }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.disk') }}</span><span class="font-mono">/dev/{{ partDeleteDlg.disk.name }}</span><span v-if="partDeleteDlg.disk.model" class="text-base-content/70">{{ partDeleteDlg.disk.model }}</span></div>
        <div v-if="partDeleteDlg.disk.serial" class="flex gap-2"><span class="w-20 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.serial') }}</span><span class="font-mono">{{ partDeleteDlg.disk.serial }}</span></div>
        <div class="flex gap-2"><span class="w-20 text-base-content/80">{{ t('ui.storage.PhysicalDisksSection.partition2') }}</span><span>{{ partNumOf(partDeleteDlg.disk.name, partDeleteDlg.part.name) }}</span></div>
      </template>
    </ConfirmDestroyDialog>

  </div>
</template>
