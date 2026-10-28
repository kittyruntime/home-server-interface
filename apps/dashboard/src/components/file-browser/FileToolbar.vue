<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { ArrowLeftIcon, ChevronDownIcon, ClipboardPasteIcon, CopyIcon, DownloadIcon, FileTextIcon, FolderPlusIcon, KeyRoundIcon, LayoutGridIcon, ListIcon, MenuIcon, PencilIcon, PlusIcon, RefreshCwIcon, ScissorsIcon, SearchIcon, Share2Icon, Trash2Icon, UploadIcon, XIcon } from '@lucide/vue'
import { ref, nextTick } from 'vue'
import { Input } from '@/components/ui/input'

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

const newMenuOpen = ref(false)
</script>

<template>
  <div
    class="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-muted flex-shrink-0 h-11"
    @click.stop
  >
    <button v-if="newMenuOpen" class="fixed inset-0 z-20" aria-label="Close menu" @click="newMenuOpen = false" />

    <!-- Mobile: places sidebar toggle -->
    <Button variant="ghost" size="icon-sm" @click="emit('toggleSidebar')" title="Places" aria-label="Toggle places sidebar"
      class="sm:hidden flex-shrink-0"
      :class="sidebarOpen ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent'">
      <MenuIcon class="w-4 h-4" aria-hidden="true" />
    </Button>

    <!-- Back / Up -->
    <Button variant="ghost" size="icon-sm" v-if="canGoUp" @click="emit('goUp')" title="Go up" aria-label="Go to parent folder"
      class="text-muted-foreground hover:text-foreground flex-shrink-0">
      <ArrowLeftIcon class="w-4 h-4" aria-hidden="true" />
    </Button>

    <!-- Breadcrumb -->
    <nav v-if="currentPath" class="flex items-center gap-0.5 text-sm flex-1 min-w-0 overflow-x-auto">
      <template v-for="(crumb, i) in breadcrumbs" :key="i">
        <span v-if="i > 0" class="text-muted-foreground select-none mx-0.5 flex-shrink-0">›</span>
        <button v-if="crumb.clickable" @click="emit('navigate', crumb.path)"
          class="px-1 py-0.5 text-muted-foreground hover:text-foreground rounded-sm hover:bg-accent transition-colors whitespace-nowrap flex-shrink-0">
          {{ crumb.label }}
        </button>
        <span v-else class="px-1 text-foreground whitespace-nowrap flex-shrink-0 truncate">{{ crumb.label }}</span>
      </template>
    </nav>
    <div v-else class="flex-1" />

    <!-- Right-side actions -->
    <div class="flex items-center gap-0.5 flex-shrink-0 ml-auto">

      <!-- Selection actions -->
      <template v-if="selectedCount > 0">
        <span class="text-xs tabular-nums text-muted-foreground select-none pl-1 pr-0.5">{{ selectedCount }} sel.</span>
        <Button variant="ghost" size="icon-xs" @click="emit('clearSelection')" title="Clear selection" aria-label="Clear selection"
          class="text-muted-foreground hover:text-foreground/80">
          <XIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
        <div class="w-px h-3.5 bg-input mx-0.5 flex-shrink-0" />

        <button @click="emit('copy')" title="Copy" aria-label="Copy selection" class="sel-btn">
          <CopyIcon class="w-4 h-4" aria-hidden="true" />
        </button>
        <button @click="emit('cut')" title="Cut" aria-label="Cut selection" class="sel-btn">
          <ScissorsIcon class="w-4 h-4" aria-hidden="true" />
        </button>

        <template v-if="selectedCount === 1">
          <button @click="emit('startRename', selectedEntries[0]!)" title="Rename" aria-label="Rename selection" class="sel-btn">
            <PencilIcon class="w-4 h-4" aria-hidden="true" />
          </button>
          <button v-if="selectedEntries[0]?.type === 'file'" @click="emit('download')" title="Download" aria-label="Download selection" class="sel-btn">
            <DownloadIcon class="w-4 h-4" aria-hidden="true" />
          </button>
          <button @click="emit('openPermissions')" title="Permissions" aria-label="Edit permissions" class="sel-btn">
            <KeyRoundIcon class="w-4 h-4" aria-hidden="true" />
          </button>
          <button @click="emit('share')" title="Share" aria-label="Share selection" class="sel-btn">
            <Share2Icon class="w-4 h-4" aria-hidden="true" />
          </button>
        </template>

        <button @click="emit('delete')" title="Delete" aria-label="Delete selection" class="sel-btn sel-btn-danger">
          <Trash2Icon class="w-4 h-4" aria-hidden="true" />
        </button>
        <div class="w-px h-3.5 bg-input mx-0.5 flex-shrink-0" />
      </template>

      <!-- New (folder / file) -->
      <div v-if="currentPath" class="relative">
        <button @click.stop="newMenuOpen = !newMenuOpen" title="New" aria-label="Create new folder or file" :aria-expanded="newMenuOpen"
          :class="['flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors text-xs',
            newMenuOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent']">
          <PlusIcon class="w-4 h-4" aria-hidden="true" />
          <span class="hidden sm:inline">New</span>
          <ChevronDownIcon class="hidden sm:block w-3 h-3" aria-hidden="true" />
        </button>
        <Transition name="ui-pop">
          <div v-if="newMenuOpen"
            class="absolute left-0 top-full z-30 mt-1.5 min-w-[160px] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
            <button @click="emit('createFolder'); newMenuOpen = false"
              class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-foreground/80 transition-colors hover:bg-accent">
              <FolderPlusIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
              New folder
            </button>
            <button @click="emit('createFile'); newMenuOpen = false"
              class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-foreground/80 transition-colors hover:bg-accent">
              <FileTextIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
              New file
            </button>
          </div>
        </Transition>
      </div>

      <!-- Upload -->
      <button v-if="currentPath" @click="emit('uploadClick')" title="Upload files" aria-label="Upload files"
        class="flex items-center gap-1 px-2 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-xs">
        <UploadIcon class="w-4 h-4" aria-hidden="true" />
        <span class="hidden sm:inline">Upload</span>
      </button>

      <!-- Paste -->
      <button v-if="clipboard && currentPath" @click.stop="emit('paste')" title="Paste" aria-label="Paste files"
        :class="['flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors',
          clipboard.mode === 'cut'
            ? 'bg-warning/15 text-warning hover:bg-warning/25'
            : 'bg-primary/10 text-primary hover:opacity-80']">
        <ClipboardPasteIcon class="w-4 h-4" aria-hidden="true" />
        <span class="hidden sm:inline">Paste {{ clipboard.mode === 'cut' ? '(move)' : '' }} {{ clipboard.paths.length > 1 ? clipboard.paths.length + ' items' : '' }}</span>
      </button>

      <!-- Divider -->
      <div v-if="currentPath" class="w-px h-4 bg-input mx-1" />

      <!-- Refresh -->
      <Button variant="ghost" size="icon-sm" v-if="currentPath" @click="emit('refresh')" title="Refresh" aria-label="Refresh folder"
        class="text-muted-foreground hover:text-foreground">
        <RefreshCwIcon class="w-4 h-4" aria-hidden="true" />
      </Button>

      <!-- View toggle -->
      <div class="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
        <button @click="emit('update:viewMode', 'list')" title="List view" aria-label="List view"
          :class="['p-1.5 rounded-md transition-colors', viewMode === 'list' ? 'bg-card text-foreground/80 shadow-sm' : 'text-muted-foreground hover:text-foreground/80']">
          <ListIcon class="w-4 h-4" aria-hidden="true" />
        </button>
        <button @click="emit('update:viewMode', 'grid')" title="Grid view" aria-label="Grid view"
          :class="['p-1.5 rounded-md transition-colors', viewMode === 'grid' ? 'bg-card text-foreground/80 shadow-sm' : 'text-muted-foreground hover:text-foreground/80']">
          <LayoutGridIcon class="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      <!-- Search: collapsed to an icon until opened, so it doesn't permanently
           claim ~150px from the breadcrumb (tight in a narrow desktop-mode
           window, tighter still on a phone). -->
      <div v-if="currentPath" class="flex items-center ml-1 border-l border-border pl-2">
        <Button variant="ghost" size="icon-sm" v-if="!searchOpen" @click="openSearch" title="Search" aria-label="Search this folder"
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
            class="pl-6 pr-6 py-1 text-xs w-28 sm:w-36"
          />
          <button @click="clearSearch" title="Close search" aria-label="Close search"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <XIcon class="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../../style.css";

.sel-btn {
  @apply p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors;
}
.sel-btn-danger:hover {
  background-color: color-mix(in srgb, var(--primary) 10%, transparent);
  color: var(--primary);
}
</style>
