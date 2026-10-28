<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { CalendarIcon, DatabaseIcon, HardDriveIcon, PackageIcon, Rows3Icon } from '@lucide/vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ref, computed, onMounted, watch } from 'vue'
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
import { createNav, takeRequest, navOpen, navCrumbs, navTo, sectionOf, leavesWizard, SECTION_LABELS, type StorageLocation, type StorageNav, type StorageSection } from '../../lib/storage-nav'
import { pendingStorageLocation } from '../../lib/storage-open'

type SectionId = StorageSection

interface NavItem { id: SectionId; label: string }

const nav: NavItem[] = (['volumes', 'disks', 'raid', 'lvm', 'mounts', 'maintenance'] as const)
  .map(id => ({ id, label: SECTION_LABELS[id] }))

// Where this panel is (#40). Each Storage panel (the classic view, a desktop
// window) keeps its own history.
const location = ref(createNav())
const active = computed<SectionId>({
  get: () => sectionOf(location.value.current),
  set: section => open({ kind: 'section', section }),
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
    if (wizardDirty.value && !await confirm('Leave the Create volume wizard? Your choices will be lost.', { confirmLabel: 'Leave' })) return
    wizardDirty.value = false
  }
  location.value = next
}
function open(loc: StorageLocation) {
  return go(navOpen(location.value, loc))
}
function focusOn(target: SectionId | StorageLocation) {
  open(typeof target === 'string' ? { kind: 'section', section: target } : target)
}

// Opened on a location from elsewhere (openStorage).
watch(pendingStorageLocation, req => {
  if (!req) return
  const loc = takeRequest(req, Date.now())
  pendingStorageLocation.value = null
  if (loc) open(loc)
}, { immediate: true })

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
</script>

<template>
  <!-- Size container: layouts follow the width of this panel (a desktop
       window or the classic view), not the screen (#40). -->
  <div class="@container h-full">
  <div class="flex flex-col @2xl:flex-row h-full">

    <!-- Mobile picker -->
    <div class="@2xl:hidden flex-shrink-0 border-b border-border bg-sidebar px-4 py-2.5">
      <Select v-model="active">
        <SelectTrigger class="w-full" aria-label="Section">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="item in nav" :key="item.id" :value="item.id">{{ item.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <!-- Left nav -->
    <nav class="hidden @2xl:flex w-48 flex-shrink-0 border-r border-border bg-sidebar py-5 px-2 flex-col gap-0.5 overflow-y-auto">
      <div v-for="item in nav" :key="item.id" class="relative flex items-center">
        <span
          v-if="active === item.id"
          class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full"
        />
        <button
          @click="active = item.id"
          :class="[
            'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left',
            active === item.id
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          ]"
        >
          <!-- Volumes -->
          <svg v-if="item.id === 'volumes'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <rect x="3" y="4" width="18" height="7" rx="2" stroke-linejoin="round"/>
            <rect x="3" y="13" width="18" height="7" rx="2" stroke-linejoin="round"/>
            <path stroke-linecap="round" d="M7 7.5h.01M7 16.5h.01"/>
          </svg>
          <!-- Disks -->
          <HardDriveIcon v-else-if="item.id === 'disks'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- RAID -->
          <PackageIcon v-else-if="item.id === 'raid'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- LVM -->
          <Rows3Icon v-else-if="item.id === 'lvm'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- Maintenance -->
          <CalendarIcon v-if="item.id === 'maintenance'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- Mounts -->
          <DatabaseIcon v-else-if="item.id === 'mounts'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          {{ item.label }}
        </button>
      </div>
    </nav>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto @container/content">
      <div class="p-4 @2xl:p-8 max-w-5xl">
        <div v-if="missingTools.length" role="status"
          class="mb-5 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
          <p class="text-foreground">
            Some storage tools are not installed on the server, so these features are unavailable:
            {{ missingTools.map(t => `${t.feature} (${t.command})`).join(', ') }}.
          </p>
          <p class="mt-1 text-muted-foreground">Install them with <code class="font-mono text-foreground/80">{{ installCommand }}</code></p>
        </div>
        <nav v-if="crumbs.length > 1" aria-label="Breadcrumb" class="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <template v-for="(c, i) in crumbs" :key="c.index">
            <span v-if="i > 0" aria-hidden="true">›</span>
            <Button variant="link" v-if="i < crumbs.length - 1" type="button" class="h-auto p-0 hover:text-foreground" @click="go(navTo(location, c.index))">{{ c.label }}</Button>
            <span v-else class="font-mono text-foreground" aria-current="location">{{ c.label }}</span>
          </template>
        </nav>
        <VolumePage v-if="location.current.kind === 'volume'" :id="location.current.id"
          @navigate="focusOn" @named="n => { if (location.current.kind === 'volume') names = { ...names, [`volume:${location.current.id}`]: n } }" />
        <CreateVolumeWizard v-else-if="location.current.kind === 'create-volume'" :disks="location.current.disks"
          @navigate="focusOn" @dirty="d => wizardDirty = d" />
        <ArrayPage v-else-if="location.current.kind === 'array'" :name="location.current.name" @navigate="focusOn" />
        <VgPage v-else-if="location.current.kind === 'vg'" :name="location.current.name" @navigate="focusOn" />
        <DiskPage v-else-if="location.current.kind === 'disk'" :name="location.current.name" @navigate="focusOn"
          @named="n => { if (location.current.kind === 'disk') names = { ...names, [`disk:${location.current.name}`]: n } }" />
        <VolumesSection v-else-if="active === 'volumes'" @navigate="focusOn" @create="startCreate" />
        <PhysicalDisksSection v-else-if="active === 'disks'" @navigate="focusOn" @open="n => open({ kind: 'disk', name: n })" @create="startCreate" />
        <RaidSection          v-else-if="active === 'raid'"   @navigate="focusOn"
          :preselect="preselect?.kind === 'raid' ? preselect.devices : undefined" @preselected="preselect = null" />
        <LvmSection           v-else-if="active === 'lvm'" @navigate="focusOn"
          :preselect="preselect?.kind === 'lvm' ? preselect.devices : undefined" @preselected="preselect = null" />
        <MountsSection        v-else-if="active === 'mounts'" @navigate="focusOn" />
        <MaintenanceSection   v-else-if="active === 'maintenance'" />
      </div>
    </div>

  </div>
  </div>
</template>
