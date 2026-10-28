<script setup lang="ts">
import Tip from '../ui/Tip.vue'
import { Button } from '@/components/ui/button'
import { ArrowLeftIcon, ChevronDownIcon, ClipboardPasteIcon, CopyIcon, DownloadIcon, FileTextIcon, FolderPlusIcon, KeyRoundIcon, LayoutGridIcon, ListIcon, MenuIcon, PencilIcon, PlusIcon, RefreshCwIcon, ScissorsIcon, SearchIcon, Share2Icon, Trash2Icon, UploadIcon, XIcon } from '@lucide/vue'
import { ref, nextTick } from 'vue'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

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
    <Button variant="ghost" size="icon-sm" @click="emit('toggleSidebar')" tooltip="Places" aria-label="Toggle places sidebar"
      class="sm:hidden flex-shrink-0"
      :class="sidebarOpen ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent'">
      <MenuIcon class="w-4 h-4" aria-hidden="true" />
    </Button>

    <!-- Back / Up -->
    <Button variant="ghost" size="icon-sm" v-if="canGoUp" @click="emit('goUp')" tooltip="Go up" aria-label="Go to parent folder"
      class="text-muted-foreground hover:text-foreground flex-shrink-0">
      <ArrowLeftIcon class="w-4 h-4" aria-hidden="true" />
    </Button>

    <!-- Breadcrumb -->
    <nav v-if="currentPath" class="flex items-center gap-0.5 text-sm flex-1 min-w-0 overflow-x-auto">
      <template v-for="(crumb, i) in breadcrumbs" :key="i">
        <span v-if="i > 0" class="text-muted-foreground select-none mx-0.5 flex-shrink-0">›</span>
        <Button v-if="crumb.clickable" variant="ghost" size="xs" @click="emit('navigate', crumb.path)"
          class="px-1 font-normal text-muted-foreground whitespace-nowrap flex-shrink-0">
          {{ crumb.label }}
        </Button>
        <span v-else class="px-1 text-foreground whitespace-nowrap flex-shrink-0 truncate">{{ crumb.label }}</span>
      </template>
    </nav>
    <div v-else class="flex-1" />

    <!-- Right-side actions -->
    <div class="flex items-center gap-0.5 flex-shrink-0 ml-auto">

      <!-- Selection actions -->
      <template v-if="selectedCount > 0">
        <span class="text-xs tabular-nums text-muted-foreground select-none pl-1 pr-0.5">{{ selectedCount }} sel.</span>
        <Button variant="ghost" size="icon-xs" @click="emit('clearSelection')" tooltip="Clear selection" aria-label="Clear selection"
          class="text-muted-foreground hover:text-foreground/80">
          <XIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
        <div class="w-px h-3.5 bg-input mx-0.5 flex-shrink-0" />

        <Button variant="ghost" size="icon-sm" @click="emit('copy')" tooltip="Copy" aria-label="Copy selection" class="text-muted-foreground">
          <CopyIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" @click="emit('cut')" tooltip="Cut" aria-label="Cut selection" class="text-muted-foreground">
          <ScissorsIcon class="w-4 h-4" aria-hidden="true" />
        </Button>

        <template v-if="selectedCount === 1">
          <Button variant="ghost" size="icon-sm" @click="emit('startRename', selectedEntries[0]!)" tooltip="Rename" aria-label="Rename selection" class="text-muted-foreground">
            <PencilIcon class="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" v-if="selectedEntries[0]?.type === 'file'" @click="emit('download')" tooltip="Download" aria-label="Download selection" class="text-muted-foreground">
            <DownloadIcon class="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" @click="emit('openPermissions')" tooltip="Permissions" aria-label="Edit permissions" class="text-muted-foreground">
            <KeyRoundIcon class="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" @click="emit('share')" tooltip="Share" aria-label="Share selection" class="text-muted-foreground">
            <Share2Icon class="w-4 h-4" aria-hidden="true" />
          </Button>
        </template>

        <Button variant="ghost" size="icon-sm" @click="emit('delete')" tooltip="Delete" aria-label="Delete selection" class="text-muted-foreground hover:text-destructive hover:bg-destructive/10">
          <Trash2Icon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <div class="w-px h-3.5 bg-input mx-0.5 flex-shrink-0" />
      </template>

      <!-- New (folder / file) -->
      <DropdownMenu v-if="currentPath">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="sm" aria-label="Create new folder or file" class="gap-1 px-2 text-xs text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground">
            <PlusIcon aria-hidden="true" />
            <span class="hidden sm:inline">New</span>
            <ChevronDownIcon class="hidden sm:block size-3" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="min-w-[160px]">
          <DropdownMenuItem @select="emit('createFolder')">
            <FolderPlusIcon aria-hidden="true" />
            New folder
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('createFile')">
            <FileTextIcon aria-hidden="true" />
            New file
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- Upload -->
      <Button variant="ghost" size="sm" v-if="currentPath" @click="emit('uploadClick')" tooltip="Upload files" aria-label="Upload files"
        class="gap-1 px-2 text-xs text-muted-foreground">
        <UploadIcon aria-hidden="true" />
        <span class="hidden sm:inline">Upload</span>
      </Button>

      <!-- Paste -->
      <Button variant="ghost" size="sm" v-if="clipboard && currentPath" @click.stop="emit('paste')" tooltip="Paste" aria-label="Paste files"
        :class="['gap-1 px-2 text-xs',
          clipboard.mode === 'cut'
            ? 'bg-warning/15 text-warning hover:bg-warning/25 hover:text-warning'
            : 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary']">
        <ClipboardPasteIcon aria-hidden="true" />
        <span class="hidden sm:inline">Paste {{ clipboard.mode === 'cut' ? '(move)' : '' }} {{ clipboard.paths.length > 1 ? clipboard.paths.length + ' items' : '' }}</span>
      </Button>

      <!-- Divider -->
      <div v-if="currentPath" class="w-px h-4 bg-input mx-1" />

      <!-- Refresh -->
      <Button variant="ghost" size="icon-sm" v-if="currentPath" @click="emit('refresh')" tooltip="Refresh" aria-label="Refresh folder"
        class="text-muted-foreground hover:text-foreground">
        <RefreshCwIcon class="w-4 h-4" aria-hidden="true" />
      </Button>

      <!-- View toggle -->
      <ToggleGroup
        type="single" variant="outline" size="sm"
        :model-value="viewMode"
        aria-label="View mode"
        @update:model-value="v => { if (v === 'list' || v === 'grid') emit('update:viewMode', v) }"
      >
        <Tip text="List view"><ToggleGroupItem value="list" aria-label="List view">
          <ListIcon aria-hidden="true" />
        </ToggleGroupItem></Tip>
        <Tip text="Grid view"><ToggleGroupItem value="grid" aria-label="Grid view">
          <LayoutGridIcon aria-hidden="true" />
        </ToggleGroupItem></Tip>
      </ToggleGroup>

      <!-- Search: collapsed to an icon until opened, so it doesn't permanently
           claim ~150px from the breadcrumb (tight in a narrow desktop-mode
           window, tighter still on a phone). -->
      <div v-if="currentPath" class="flex items-center ml-1 border-l border-border pl-2">
        <Button variant="ghost" size="icon-sm" v-if="!searchOpen" @click="openSearch" tooltip="Search" aria-label="Search this folder"
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
            placeholder="Search…"
            class="h-7 pl-6 pr-6 text-xs w-28 sm:w-36"
          />
          <Button variant="ghost" size="icon-xs" @click="clearSearch" tooltip="Close search" aria-label="Close search"
            class="absolute right-0.5 top-1/2 -translate-y-1/2 size-5 text-muted-foreground">
            <XIcon class="size-3" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

