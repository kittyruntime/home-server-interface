<script setup lang="ts">
import LoadingState from '../ui/LoadingState.vue'
import PartitionsSection from './PartitionsSection.vue'
import { loadZfs, zfs } from './zfs-data'
import ZfsImportSection from './ZfsImportSection.vue'
import SnapshotsSection from './SnapshotsSection.vue'
import DatasetsSection from './DatasetsSection.vue'
import PoolsSection from './PoolsSection.vue'
import PoolPage from './PoolPage.vue'
import { useI18n } from 'vue-i18n'
import { Alert } from '@/components/ui/alert'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import SectionNav from '@/components/ui/SectionNav.vue'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CalendarIcon, DatabaseIcon, CameraIcon, DownloadIcon, ScissorsIcon, HardDriveIcon, LayersIcon, PackageIcon, Rows3Icon, ServerIcon } from '@lucide/vue'
import { ref, computed, onMounted, watch } from 'vue'
import type { Component } from 'vue'
import PhysicalDisksSection from './PhysicalDisksSection.vue'
import VolumesSection from './VolumesSection.vue'
import VolumePage from './VolumePage.vue'
import DiskPage from './DiskPage.vue'
import ArrayPage from './ArrayPage.vue'
import CreateVolumeWizard from './CreateVolumeWizard.vue'
import { useConfirm } from '../../lib/confirm'
import VgPage from './VgPage.vue'
import RaidSection from './RaidSection.vue'
import LvmSection from './LvmSection.vue'
import MountsSection from './MountsSection.vue'
import MaintenanceSection from './MaintenanceSection.vue'
import { useHostTools } from './tools'
import { trpc } from '../../lib/trpc'
import { navCrumbs, navTo, sectionOf, leavesWizard, SECTION_LABELS, TAB_LABELS, TAB_SECTIONS, createTabbedNav, currentNav, defaultTab, switchTab, tabbedOpen, visibleTabs, withNav, type StorageLocation, type StorageSection, type StorageTab, type TabbedNav } from '../../lib/storage-nav'

const { t } = useI18n()

type SectionId = StorageSection

// Where this panel is (#40): a tab, and in each tab a stack of locations. Each
// Storage panel (the classic view, a desktop window) keeps its own history.
const tabbed = ref<TabbedNav>(createTabbedNav('disks'))
const location = computed(() => currentNav(tabbed.value))
const active = computed<SectionId>({
  get: () => sectionOf(location.value.current),
  set: section => open({ kind: 'section', section }),
})
// The tabs shown: one without sections (ZFS until it is detected) is hidden.
const TAB_ICONS: Record<StorageTab, Component> = { disks: HardDriveIcon, lvm: Rows3Icon, zfs: DatabaseIcon, maintenance: CalendarIcon }
const tabs = computed(() => visibleTabs({ zfs: !!zfs.value && (zfs.value.available || zfs.value.watched.length > 0) }).map(id => ({ id, label: TAB_LABELS[id], icon: TAB_ICONS[id] })))
const tab = computed<StorageTab>({
  get: () => tabbed.value.tab,
  set: next => { void go(switchTab(tabbed.value, next)) },
})
// Names of the objects on the stack, as their pages resolve them.
const names = ref<Record<string, string>>({})
const crumbs = computed(() => navCrumbs(location.value, names.value))
// The wizard has choices made: leaving it asks first (#40).
const wizardDirty = ref(false)
const panelEmit = defineEmits<{ dirty: [dirty: boolean] }>()
watch(wizardDirty, d => panelEmit('dirty', d))
const { confirm } = useConfirm()
// Every move goes through here: links, sections and breadcrumbs alike.
async function go(next: TabbedNav) {
  moved = true
  if (leavesWizard(location.value, currentNav(next))) {
    if (wizardDirty.value && !await confirm(t('uis.storage.StoragePanel.leaveTheCreateVolumeWizard'), { confirmLabel: t('uis.storage.StoragePanel.leave') })) return
    wizardDirty.value = false
  }
  tabbed.value = next
}
function open(loc: StorageLocation) {
  return go(tabbedOpen(tabbed.value, loc))
}
// Storage opens on Disks until a volume exists (defaultTab), unless the user
// moved before the volumes were known.
let moved = false
// Nothing shows until the tab is known (or 3 s pass), so the page does not
// jump from Disks to another tab under the user.
const started = ref(false)
onMounted(async () => {
  const give = setTimeout(() => { started.value = true }, 3000)
  try {
    const [overview] = await Promise.all([trpc.storage.volumes.overview.query(), loadZfs()])
    const zfsCount = overview.volumes.filter(v => v.engine === 'zfs').length
    if (!moved) tabbed.value = createTabbedNav(defaultTab({ volumes: overview.volumes.length - zfsCount, zfsVolumes: zfsCount }))
  } catch { /* stays on Disks */ } finally {
    clearTimeout(give)
    started.value = true
  }
})
function focusOn(target: SectionId | StorageLocation) {
  open(typeof target === 'string' ? { kind: 'section', section: target } : target)
}

// Free disks picked in Devices, handed to the RAID or LVM create wizard.
const preselect = ref<{ kind: 'raid' | 'lvm'; devices: string[] } | null>(null)
function startCreate(kind: 'raid' | 'lvm' | 'volume', devices: string[]) {
  if (kind === 'volume') { void open({ kind: 'create-volume', disks: devices }); return }
  preselect.value = { kind, devices }
  void open({ kind: 'section', section: kind })
}

const { load: loadTools, missingStorageTools } = useHostTools()
onMounted(() => { void loadTools() })
const missingTools = computed(() => missingStorageTools())
const installCommand = computed(() =>
  `sudo apt install ${[...new Set(missingTools.value.map(t => t.package))].join(' ')}`)

const ICONS: Record<SectionId, Component> = {
  'volumes': ServerIcon, 'disks': HardDriveIcon, 'raid': PackageIcon, 'lvm': Rows3Icon,
  'mounts': DatabaseIcon, 'maintenance': CalendarIcon, 'partitions': ScissorsIcon,
  'pools': DatabaseIcon, 'datasets': LayersIcon, 'snapshots': CameraIcon, 'zfs-import': DownloadIcon,
}
const navItems = computed(() => TAB_SECTIONS[tab.value].map(id => ({ id, label: SECTION_LABELS[id], icon: ICONS[id] })))
</script>

<template>
  <!-- Size container: layouts follow the width of this panel (a desktop
       window or the classic view), not the screen (#40). -->
  <div class="@container flex h-full flex-col">
    <!-- Manual activation: arrow keys move the focus; Enter or Space opens a tab
         (an open wizard asks before leaving, it must not ask on each arrow key). -->
    <Tabs v-model="tab" activation-mode="manual" class="shrink-0 border-b border-base-300 px-4 pt-3 @2xl:px-6">
      <TabsList class="max-w-full overflow-x-auto" :aria-label="t('ui.storage.StoragePanel.storageTabs')">
        <TabsTrigger v-for="item in tabs" :key="item.id" :value="item.id">
          <span class="inline-flex items-center gap-1.5 whitespace-nowrap"><component :is="item.icon" class="size-4" aria-hidden="true" />{{ item.label }}</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
    <div class="flex min-h-0 flex-1 flex-col @2xl:flex-row">

      <SectionNav v-if="navItems.length > 1" v-model="active" :items="navItems" container />

      <!-- Content -->
      <div class="flex-1 overflow-y-auto @container/content">
        <div class="p-4 @2xl:p-8 max-w-5xl">
          <LoadingState v-if="!started" variant="block" />
          <template v-else>
            <Alert variant="warning" v-if="missingTools.length" role="status"
              class="block mb-5">
              <p class="text-base-content">
                {{ t('uip.storage.StoragePanel.someStorageToolsAreNot', { p0: missingTools.map(t => `${t.feature} (${t.command})`).join(', ') }) }}
              </p>
              <p class="mt-1 text-base-content/70">{{ t('ui.storage.StoragePanel.installThemWith') }} <code class="font-mono text-base-content/80">{{ installCommand }}</code></p>
            </Alert>
            <Breadcrumb v-if="crumbs.length > 1" class="mb-4">
              <BreadcrumbList class="text-xs sm:gap-1.5">
                <template v-for="(c, i) in crumbs" :key="c.index">
                  <BreadcrumbSeparator v-if="i > 0" />
                  <BreadcrumbItem>
                    <BreadcrumbLink v-if="i < crumbs.length - 1" as="button" type="button" @click="go(withNav(tabbed, navTo(location, c.index)))">{{ c.label }}</BreadcrumbLink>
                    <BreadcrumbPage v-else class="font-mono">{{ c.label }}</BreadcrumbPage>
                  </BreadcrumbItem>
                </template>
              </BreadcrumbList>
            </Breadcrumb>
            <VolumePage v-if="location.current.kind === 'volume'" :id="location.current.id"
              @navigate="focusOn" @named="n => { if (location.current.kind === 'volume') names = { ...names, [`volume:${location.current.id}`]: n } }" />
            <CreateVolumeWizard v-else-if="location.current.kind === 'create-volume'" :disks="location.current.disks"
              @navigate="focusOn" @dirty="d => wizardDirty = d" />
            <ArrayPage v-else-if="location.current.kind === 'array'" :name="location.current.name" @navigate="focusOn" />
            <VgPage v-else-if="location.current.kind === 'vg'" :name="location.current.name" @navigate="focusOn" />
            <PoolPage v-else-if="location.current.kind === 'pool'" :name="location.current.name" @navigate="focusOn" />
            <DiskPage v-else-if="location.current.kind === 'disk'" :name="location.current.name" @navigate="focusOn"
              @named="n => { if (location.current.kind === 'disk') names = { ...names, [`disk:${location.current.name}`]: n } }" />
            <VolumesSection v-else-if="active === 'volumes'" @navigate="focusOn" />
            <PhysicalDisksSection v-else-if="active === 'disks'" @navigate="focusOn" @open="n => open({ kind: 'disk', name: n })" @create="startCreate" />
            <RaidSection v-else-if="active === 'raid'" @navigate="focusOn"
              :preselect="preselect?.kind === 'raid' ? preselect.devices : undefined" @preselected="preselect = null" />
            <LvmSection v-else-if="active === 'lvm'" @navigate="focusOn"
              :preselect="preselect?.kind === 'lvm' ? preselect.devices : undefined" @preselected="preselect = null" />
            <MountsSection v-else-if="active === 'mounts'" @navigate="focusOn" />
            <PartitionsSection v-else-if="active === 'partitions'" @navigate="focusOn" />
            <MaintenanceSection v-else-if="active === 'maintenance'" />
            <PoolsSection v-else-if="active === 'pools'" @navigate="focusOn" />
            <DatasetsSection v-else-if="active === 'datasets'" @navigate="focusOn" />
            <SnapshotsSection v-else-if="active === 'snapshots'" />
            <ZfsImportSection v-else-if="active === 'zfs-import'" @navigate="focusOn" />
          </template>
        </div>
      </div>

    </div>
  </div>
</template>
