<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import Tip from '../ui/Tip.vue'
import { Button } from '@/components/ui/button'
import { ArrowLeftIcon, ChevronDownIcon, ClipboardPasteIcon, CopyIcon, DownloadIcon, FileTextIcon, FolderPlusIcon, KeyRoundIcon, LayoutGridIcon, ListIcon, MenuIcon, PencilIcon, PlusIcon, RefreshCwIcon, ScissorsIcon, SearchIcon, Share2Icon, Trash2Icon, UploadIcon, XIcon } from '@lucide/vue'
import { ref, nextTick } from 'vue'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const { t } = useI18n()

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }
type Crumb = { label: string; path: string; clickable: boolean }

defineProps<{
  currentPath: string | null
  breadcrumbs: Crumb[]
  canGoUp: boolean
  selectedCount: number
  selectedEntries: Entry[]
  clipboard: { paths: readonly string[]; mode: 'copy' | 'cut' } | null
  viewMode: 'list' | 'grid'
  sidebarOpen: boolean
}>()

const emit = defineEmits<{
  goUp: []
  navigate: [path: string]
  clearSelection: []
  copy: []
  cut: []
  startRename: [entry: Entry]
  download: []
  openPermissions: []
  share: []
  delete: []
  createFolder: []
  createFile: []
  uploadClick: []
  paste: []
  refresh: []
  'update:viewMode': [mode: 'list' | 'grid']
  toggleSidebar: []
  search: [query: string]
}>()

const searchQuery = ref('')
const searchOpen  = ref(false)
const searchInput = ref<InstanceType<typeof Input> | null>(null)

function submitSearch() {
  if (searchQuery.value.trim()) emit('search', searchQuery.value.trim())
}

function clearSearch() {
  searchQuery.value = ''
  searchOpen.value = false
  emit('search', '')
}

async function openSearch() {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
}

</script>

<template>
  <div
    class="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-muted flex-shrink-0 h-11"
    @click.stop
  >
    <!-- Mobile: places sidebar toggle -->
    <Button variant="ghost" size="icon-sm" @click="emit('toggleSidebar')" :tooltip="t('ui.files.FileToolbar.places')" :aria-label="t('ui.files.FileToolbar.togglePlacesSidebar')"
      class="sm:hidden flex-shrink-0"
      :class="sidebarOpen ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent'">
      <MenuIcon class="w-4 h-4" aria-hidden="true" />
    </Button>

    <!-- Back / Up -->
    <Button variant="ghost" size="icon-sm" v-if="canGoUp" @click="emit('goUp')" :tooltip="t('ui.files.FileToolbar.goUp')" :aria-label="t('ui.files.FileToolbar.goToParentFolder')"
      class="text-muted-foreground hover:text-foreground flex-shrink-0">
      <ArrowLeftIcon class="w-4 h-4" aria-hidden="true" />
    </Button>

    <!-- Breadcrumb -->
    <Breadcrumb v-if="currentPath" class="flex-1 min-w-0 overflow-x-auto">
      <BreadcrumbList class="flex-nowrap gap-1 sm:gap-1">
        <template v-for="(crumb, i) in breadcrumbs" :key="i">
          <BreadcrumbSeparator v-if="i > 0" class="shrink-0" />
          <BreadcrumbItem class="shrink-0 whitespace-nowrap">
            <BreadcrumbLink v-if="crumb.clickable" as="button" type="button" class="rounded-sm px-1" @click="emit('navigate', crumb.path)">{{ crumb.label }}</BreadcrumbLink>
            <BreadcrumbPage v-else class="truncate px-1">{{ crumb.label }}</BreadcrumbPage>
          </BreadcrumbItem>
        </template>
      </BreadcrumbList>
    </Breadcrumb>
    <div v-else class="flex-1" />

    <!-- Right-side actions -->
    <div class="flex items-center gap-0.5 flex-shrink-0 ml-auto">

      <!-- Selection actions -->
      <template v-if="selectedCount > 0">
        <span class="text-xs tabular-nums text-muted-foreground select-none pl-1 pr-0.5">{{ selectedCount }} sel.</span>
        <Button variant="ghost" size="icon-xs" @click="emit('clearSelection')" :tooltip="t('ui.files.FileToolbar.clearSelection')" :aria-label="t('ui.files.FileToolbar.clearSelection')"
          class="text-muted-foreground hover:text-foreground/80">
          <XIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
        <Separator orientation="vertical" class="data-[orientation=vertical]:h-3.5 mx-0.5 shrink-0" />

        <Button variant="ghost" size="icon-sm" @click="emit('copy')" :tooltip="t('ui.files.FileToolbar.copy')" :aria-label="t('ui.files.FileToolbar.copySelection')" class="text-muted-foreground">
          <CopyIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" @click="emit('cut')" :tooltip="t('ui.files.FileToolbar.cut')" :aria-label="t('ui.files.FileToolbar.cutSelection')" class="text-muted-foreground">
          <ScissorsIcon class="w-4 h-4" aria-hidden="true" />
        </Button>

        <template v-if="selectedCount === 1">
          <Button variant="ghost" size="icon-sm" @click="emit('startRename', selectedEntries[0]!)" :tooltip="t('ui.files.FileToolbar.rename')" :aria-label="t('ui.files.FileToolbar.renameSelection')" class="text-muted-foreground">
            <PencilIcon class="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" v-if="selectedEntries[0]?.type === 'file'" @click="emit('download')" :tooltip="t('ui.files.FileToolbar.download')" :aria-label="t('ui.files.FileToolbar.downloadSelection')" class="text-muted-foreground">
            <DownloadIcon class="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" @click="emit('openPermissions')" :tooltip="t('ui.files.FileToolbar.permissions')" :aria-label="t('ui.files.FileToolbar.editPermissions')" class="text-muted-foreground">
            <KeyRoundIcon class="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" @click="emit('share')" :tooltip="t('ui.files.FileToolbar.share')" :aria-label="t('ui.files.FileToolbar.shareSelection')" class="text-muted-foreground">
            <Share2Icon class="w-4 h-4" aria-hidden="true" />
          </Button>
        </template>

        <Button variant="ghost" size="icon-sm" @click="emit('delete')" :tooltip="t('ui.files.FileToolbar.delete')" :aria-label="t('ui.files.FileToolbar.deleteSelection')" class="text-muted-foreground hover:text-destructive hover:bg-destructive/10">
          <Trash2Icon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <Separator orientation="vertical" class="data-[orientation=vertical]:h-3.5 mx-0.5 shrink-0" />
      </template>

      <!-- New (folder / file) -->
      <DropdownMenu v-if="currentPath">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="sm" :aria-label="t('ui.files.FileToolbar.createNewFolderOrFile')" class="gap-1 px-2 text-xs text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground">
            <PlusIcon aria-hidden="true" />
            <span class="hidden sm:inline">{{ t('ui.files.FileToolbar.new') }}</span>
            <ChevronDownIcon class="hidden sm:block size-3" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="min-w-[160px]">
          <DropdownMenuItem @select="emit('createFolder')">
            <FolderPlusIcon aria-hidden="true" />
            {{ t('ui.files.FileToolbar.newFolder') }}
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('createFile')">
            <FileTextIcon aria-hidden="true" />
            {{ t('ui.files.FileToolbar.newFile') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- Upload -->
      <Button variant="ghost" size="sm" v-if="currentPath" @click="emit('uploadClick')" :tooltip="t('ui.files.FileToolbar.uploadFiles')" :aria-label="t('ui.files.FileToolbar.uploadFiles')"
        class="gap-1 px-2 text-xs text-muted-foreground">
        <UploadIcon aria-hidden="true" />
        <span class="hidden sm:inline">{{ t('ui.files.FileToolbar.upload') }}</span>
      </Button>

      <!-- Paste -->
      <Button variant="ghost" size="sm" v-if="clipboard && currentPath" @click.stop="emit('paste')" :tooltip="t('ui.files.FileToolbar.paste')" :aria-label="t('ui.files.FileToolbar.pasteFiles')"
        :class="['gap-1 px-2 text-xs',
          clipboard.mode === 'cut'
            ? 'bg-warning/15 text-warning hover:bg-warning/25 hover:text-warning'
            : 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary']">
        <ClipboardPasteIcon aria-hidden="true" />
        <span class="hidden sm:inline">{{ t('uip.files.FileToolbar.paste', { p0: clipboard.mode === 'cut' ? '(move)' : '', p1: clipboard.paths.length > 1 ? clipboard.paths.length + ' items' : '' }) }}</span>
      </Button>

      <!-- Divider -->
      <Separator v-if="currentPath" orientation="vertical" class="data-[orientation=vertical]:h-4 mx-1" />

      <!-- Refresh -->
      <Button variant="ghost" size="icon-sm" v-if="currentPath" @click="emit('refresh')" :tooltip="t('ui.files.FileToolbar.refresh')" :aria-label="t('ui.files.FileToolbar.refreshFolder')"
        class="text-muted-foreground hover:text-foreground">
        <RefreshCwIcon class="w-4 h-4" aria-hidden="true" />
      </Button>

      <!-- View toggle -->
      <ToggleGroup
        type="single" variant="outline" size="sm"
        :model-value="viewMode"
        :aria-label="t('ui.files.FileToolbar.viewMode')"
        @update:model-value="v => { if (v === 'list' || v === 'grid') emit('update:viewMode', v) }"
      >
        <Tip text="List view"><ToggleGroupItem value="list" :aria-label="t('ui.files.FileToolbar.listView')">
          <ListIcon aria-hidden="true" />
        </ToggleGroupItem></Tip>
        <Tip text="Grid view"><ToggleGroupItem value="grid" :aria-label="t('ui.files.FileToolbar.gridView')">
          <LayoutGridIcon aria-hidden="true" />
        </ToggleGroupItem></Tip>
      </ToggleGroup>

      <!-- Search: collapsed to an icon until opened, so it doesn't permanently
           claim ~150px from the breadcrumb (tight in a narrow desktop-mode
           window, tighter still on a phone). -->
      <div v-if="currentPath" class="flex items-center ml-1 border-l border-border pl-2">
        <Button variant="ghost" size="icon-sm" v-if="!searchOpen" @click="openSearch" :tooltip="t('ui.files.FileToolbar.search')" :aria-label="t('ui.files.FileToolbar.searchThisFolder')"
          class="text-muted-foreground hover:text-foreground">
          <SearchIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <div v-else class="relative">
          <SearchIcon class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" aria-hidden="true" />
          <Input
            ref="searchInput"
            v-model="searchQuery"
            @keydown.enter="submitSearch"
            @keydown.escape="clearSearch"
            type="text"
            :placeholder="t('ui.files.FileToolbar.search2')"
            class="h-7 pl-6 pr-6 text-xs w-28 sm:w-36"
          />
          <Button variant="ghost" size="icon-xs" @click="clearSearch" :tooltip="t('ui.files.FileToolbar.closeSearch')" :aria-label="t('ui.files.FileToolbar.closeSearch')"
            class="absolute right-0.5 top-1/2 -translate-y-1/2 size-5 text-muted-foreground">
            <XIcon class="size-3" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

