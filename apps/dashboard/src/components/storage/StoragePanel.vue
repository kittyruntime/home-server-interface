<script setup lang="ts">
import { loadZfs, zfs } from './zfs-data'
import SnapshotsSection from './SnapshotsSection.vue'
import PoolsSection from './PoolsSection.vue'
import PoolsImport from './PoolsImport.vue'
import PoolPage from './PoolPage.vue'
import OverviewSection from './OverviewSection.vue'
import DisksSection from './DisksSection.vue'
import { useI18n } from 'vue-i18n'
import { Alert } from '@/components/ui/alert'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import SectionNav from '@/components/ui/SectionNav.vue'
import { CalendarCheckIcon, CameraIcon, DatabaseIcon, FolderTreeIcon, GaugeIcon, HardDriveIcon, Layers3Icon } from '@lucide/vue'
import { ref, computed, onMounted, watch } from 'vue'
import type { Component } from 'vue'
import VolumesSection from './VolumesSection.vue'
import VolumePage from './VolumePage.vue'
import DiskPage from './DiskPage.vue'
import ArrayPage from './ArrayPage.vue'
import CreateVolumeWizard from './CreateVolumeWizard.vue'
import { useConfirm } from '../../lib/confirm'
import VgPage from './VgPage.vue'
import MountsSection from './MountsSection.vue'
import MaintenanceSection from './MaintenanceSection.vue'
import { useHostTools } from './tools'
import { createNav, navCrumbs, navOpen, navTo, sectionOf, leavesWizard, visibleSections, SECTION_LABELS, type StorageLocation, type StorageNav, type StorageSection } from '../../lib/storage-nav'

const { t } = useI18n()

// Where this panel is (#40): a stack of locations under one section. Menus are
// by function; ZFS, LVM and mdadm are types shown on the objects. Each Storage
// panel (the classic view, a desktop window) keeps its own history.
const location = ref<StorageNav>(createNav())
const active = computed<StorageSection>({
  get: () => sectionOf(location.value.current),
  set: section => { void open({ kind: 'section', section }) },
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
async function go(next: StorageNav) {
  if (leavesWizard(location.value, next)) {
    if (wizardDirty.value && !await confirm(t('uis.storage.StoragePanel.leaveTheCreateVolumeWizard'), { confirmLabel: t('uis.storage.StoragePanel.leave') })) return
    wizardDirty.value = false
  }
  location.value = next
}
function open(loc: StorageLocation) {
  return go(navOpen(location.value, loc))
}
function focusOn(target: StorageSection | StorageLocation) {
  void open(typeof target === 'string' ? { kind: 'section', section: target } : target)
}
onMounted(() => { void loadZfs() })

// A free bay of Disks starts the Create volume wizard with its disks.
function startCreate(_kind: string, devices: string[]) {
  void open({ kind: 'create-volume', disks: devices })
}

const { load: loadTools, missingStorageTools } = useHostTools()
onMounted(() => { void loadTools() })
const missingTools = computed(() => missingStorageTools())
const installCommand = computed(() =>
  `sudo apt install ${[...new Set(missingTools.value.map(t => t.package))].join(' ')}`)

const ICONS: Record<StorageSection, Component> = {
  overview: GaugeIcon, disks: HardDriveIcon, pools: Layers3Icon, volumes: DatabaseIcon,
  mounts: FolderTreeIcon, snapshots: CameraIcon, maintenance: CalendarCheckIcon,
}
// Snapshots only when a type that has them is there (ZFS today).
const navItems = computed(() => visibleSections({ snapshots: !!zfs.value?.available })
  .map(id => ({ id, label: SECTION_LABELS[id], icon: ICONS[id] })))
</script>

<template>
  <!-- Size container: layouts follow the width of this panel (a desktop
       window or the classic view), not the screen (#40). -->
  <div class="@container flex h-full flex-col">
    <div class="flex min-h-0 flex-1 flex-col @2xl:flex-row">

      <SectionNav v-if="navItems.length > 1" v-model="active" :items="navItems" container />

      <!-- Content -->
      <div class="flex-1 overflow-y-auto @container/content">
        <div class="p-4 @2xl:p-8 max-w-5xl">
          <template v-if="location">
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
                    <BreadcrumbLink v-if="i < crumbs.length - 1" as="button" type="button" @click="go(navTo(location, c.index))">{{ c.label }}</BreadcrumbLink>
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
            <PoolsImport v-else-if="location.current.kind === 'import'" @navigate="focusOn" />
            <OverviewSection v-else-if="active === 'overview'" @navigate="focusOn" />
            <DisksSection v-else-if="active === 'disks'" @navigate="focusOn" @open="n => open({ kind: 'disk', name: n })" @create="startCreate" />
            <PoolsSection v-else-if="active === 'pools'" @navigate="focusOn" />
            <VolumesSection v-else-if="active === 'volumes'" @navigate="focusOn" />
            <MountsSection v-else-if="active === 'mounts'" @navigate="focusOn" />
            <SnapshotsSection v-else-if="active === 'snapshots'" />
            <MaintenanceSection v-else-if="active === 'maintenance'" @navigate="focusOn" />
          </template>
        </div>
      </div>

    </div>
  </div>
</template>
