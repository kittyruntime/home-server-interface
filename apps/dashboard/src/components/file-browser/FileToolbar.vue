<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import Tip from '../ui/Tip.vue'
import { Button } from '@/components/ui/button'
import { ArrowLeftIcon, BookmarkIcon, EyeIcon, ChevronDownIcon, ClipboardPasteIcon, CopyIcon, DownloadIcon, FileTextIcon, FolderPlusIcon, KeyRoundIcon, LayoutGridIcon, ListIcon, MenuIcon, PencilIcon, PlusIcon, RefreshCwIcon, ScissorsIcon, SearchIcon, Share2Icon, Trash2Icon, UploadIcon, XIcon } from '@lucide/vue'
import { computed, ref, nextTick, watch } from 'vue'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import SortMenu from './SortMenu.vue'
import CopyPath from './CopyPath.vue'
import { useFolderDrop, type DropAction } from '../../lib/file-drag'

const { t } = useI18n()

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }
type Crumb = { label: string; path: string; clickable: boolean }

const props = defineProps<{
  currentPath: string | null
  breadcrumbs: Crumb[]
  /** The selection goes to a trash when deleted (#200). */
  toTrash?: boolean
  /** The current folder is bookmarked (#199). */
  bookmarked?: boolean
  canGoUp: boolean
  selectedCount: number
  selectedEntries: Entry[]
  clipboard: { paths: readonly string[]; mode: 'copy' | 'cut' } | null
  viewMode: 'list' | 'grid'
  sidebarOpen: boolean
}>()

// A file is shown (its preview), a folder is opened.
const openLabel = computed(() => props.selectedEntries[0]?.type === 'file' ? t('ui.files.FileBrowserPanel.view') : t('ui.files.FileBrowserPanel.open'))

const emit = defineEmits<{
  goUp: []
  navigate: [path: string]
  clearSelection: []
  copy: []
  cut: []
  startRename: [entry: Entry]
  open: [entry: Entry]
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
  openDisplaySettings: []
  toggleBookmark: []
  dropInto: [dir: string, paths: string[], action: DropAction]
  search: [query: string]
}>()

// A crumb takes items dragged onto it: they move up into that folder.
const crumbDrop = useFolderDrop((dir, paths, action) => emit('dropInto', dir, paths, action))

// A deep path scrolls so the current folder stays in sight.
const crumbsEl = ref<{ $el?: HTMLElement } | null>(null)
watch(() => props.currentPath, () => nextTick(() => {
  const el = crumbsEl.value?.$el
  if (el) el.scrollLeft = el.scrollWidth
}), { immediate: true })


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
  <!-- Laid out by its own width (container queries), not the screen's: a
       narrow window on a wide screen gets the phone layout, the path on its own
       row, instead of a path squeezed to a few letters. -->
  <div class="@container flex-shrink-0 border-b border-base-300 bg-base-200" @click.stop>
  <div class="flex flex-wrap @3xl:flex-nowrap items-center gap-x-1.5 gap-y-1 px-3 py-2 @3xl:h-11">
    <!-- Mobile: places sidebar toggle -->
    <Button variant="ghost" size="icon-sm" @click="emit('toggleSidebar')" :tooltip="t('ui.files.FileToolbar.places')" :aria-label="t('ui.files.FileToolbar.togglePlacesSidebar')"
      class="sm:hidden flex-shrink-0"
      :class="sidebarOpen ? 'text-primary bg-primary/10' : 'text-base-content/70 hover:text-base-content hover:bg-base-200'">
      <MenuIcon class="w-4 h-4" aria-hidden="true" />
    </Button>

    <!-- Back / Up -->
    <Button variant="ghost" size="icon-sm" v-if="canGoUp" @click="emit('goUp')" :tooltip="t('ui.files.FileToolbar.goUp')" :aria-label="t('ui.files.FileToolbar.goToParentFolder')"
      class="text-base-content/70 hover:text-base-content flex-shrink-0">
      <ArrowLeftIcon class="w-4 h-4" aria-hidden="true" />
    </Button>

    <!-- Breadcrumb -->
    <!-- On a phone the actions fill the first row: the path gets its own, scrolled to the current folder. -->
    <Breadcrumb v-if="currentPath" ref="crumbsEl" class="order-last basis-full grow @3xl:order-none @3xl:basis-0 min-w-0 overflow-x-auto [scrollbar-width:none]">
      <BreadcrumbList class="flex-nowrap gap-1">
        <template v-for="(crumb, i) in breadcrumbs" :key="i">
          <BreadcrumbSeparator v-if="i > 0" class="shrink-0" />
          <BreadcrumbItem class="shrink-0 whitespace-nowrap">
            <BreadcrumbLink v-if="crumb.clickable" as="button" type="button"
              :class="['rounded-sm px-1', crumbDrop.over.value === crumb.path ? 'bg-primary/15 text-primary outline-2 outline-primary' : '']"
              @click="emit('navigate', crumb.path)"
              @dragover="crumbDrop.onDragOver(crumb.path, $event)" @dragleave="crumbDrop.onDragLeave(crumb.path)" @drop="crumbDrop.onDrop(crumb.path, $event)">{{ crumb.label }}</BreadcrumbLink>
            <!-- The current folder copies its path when clicked (#197). -->
            <CopyPath v-else-if="currentPath && i === breadcrumbs.length - 1" :path="currentPath" aria-current="page" class="px-1 text-base-content">{{ crumb.label }}</CopyPath>
            <BreadcrumbPage v-else class="truncate px-1">{{ crumb.label }}</BreadcrumbPage>
          </BreadcrumbItem>
        </template>
      </BreadcrumbList>
    </Breadcrumb>
    <div v-else class="hidden @3xl:block flex-1" />

    <!-- Right-side actions: they wrap (right-aligned) rather than overflow when
         a selection adds its buttons to a narrow bar. -->
    <div class="flex flex-1 @3xl:flex-none flex-wrap items-center justify-end gap-0.5 gap-y-1 min-w-0 ml-auto">

      <!-- Selection actions -->
      <template v-if="selectedCount > 0">
        <span class="text-xs tabular-nums text-base-content/70 select-none pl-1 pr-0.5">{{ selectedCount }} sel.</span>
        <Button variant="ghost" size="icon-xs" @click="emit('clearSelection')" :tooltip="t('ui.files.FileToolbar.clearSelection')" :aria-label="t('ui.files.FileToolbar.clearSelection')"
          class="text-base-content/70 hover:text-base-content/80">
          <XIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
        <Separator orientation="vertical" class="data-[orientation=vertical]:h-3.5 mx-0.5 shrink-0" />

        <!-- In the order of the context menu: get it, move it, change it, remove it, then its details. -->
        <Button variant="ghost" size="icon-sm" v-if="selectedCount === 1" @click="emit('open', selectedEntries[0]!)" :tooltip="`${openLabel} (Enter)`" :aria-label="openLabel" aria-keyshortcuts="Enter" class="text-base-content/70">
          <EyeIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" v-if="selectedCount === 1 && selectedEntries[0]?.type === 'file'" @click="emit('download')" :tooltip="t('ui.files.FileToolbar.download')" :aria-label="t('ui.files.FileToolbar.downloadSelection')" class="text-base-content/70">
          <DownloadIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" @click="emit('cut')" :tooltip="`${t('ui.files.FileToolbar.cut')} (Ctrl+X)`" :aria-label="t('ui.files.FileToolbar.cutSelection')" aria-keyshortcuts="Control+X" class="text-base-content/70">
          <ScissorsIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" @click="emit('copy')" :tooltip="`${t('ui.files.FileToolbar.copy')} (Ctrl+C)`" :aria-label="t('ui.files.FileToolbar.copySelection')" aria-keyshortcuts="Control+C" class="text-base-content/70">
          <CopyIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <template v-if="selectedCount === 1">
          <Button variant="ghost" size="icon-sm" @click="emit('startRename', selectedEntries[0]!)" :tooltip="`${t('ui.files.FileToolbar.rename')} (F2)`" :aria-label="t('ui.files.FileToolbar.renameSelection')" aria-keyshortcuts="F2" class="text-base-content/70">
            <PencilIcon class="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" @click="emit('share')" :tooltip="t('ui.files.FileToolbar.share')" :aria-label="t('ui.files.FileToolbar.shareSelection')" class="text-base-content/70">
            <Share2Icon class="w-4 h-4" aria-hidden="true" />
          </Button>
        </template>
        <Button variant="ghost" size="icon-sm" @click="emit('delete')" :tooltip="`${toTrash ? t('files.trash.moveToTrash') : t('ui.files.FileToolbar.delete')} (Del)`" :aria-label="toTrash ? t('files.trash.moveToTrash') : t('ui.files.FileToolbar.deleteSelection')" aria-keyshortcuts="Delete" class="text-base-content/70 hover:text-error hover:bg-error/10">
          <Trash2Icon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" v-if="selectedCount === 1" @click="emit('openPermissions')" :tooltip="t('ui.files.FileToolbar.permissions')" :aria-label="t('ui.files.FileToolbar.editPermissions')" class="text-base-content/70">
          <KeyRoundIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <Separator orientation="vertical" class="data-[orientation=vertical]:h-3.5 mx-0.5 shrink-0" />
      </template>

      <!-- New (folder / file) -->
      <DropdownMenu v-if="currentPath">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="sm" :aria-label="t('ui.files.FileToolbar.createNewFolderOrFile')" class="gap-1 px-2 text-xs text-base-content/70 data-[state=open]:bg-base-200 data-[state=open]:text-base-content">
            <PlusIcon aria-hidden="true" />
            <span class="hidden @xl:inline">{{ t('ui.files.FileToolbar.new') }}</span>
            <ChevronDownIcon class="hidden @xl:block size-3" aria-hidden="true" />
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
        class="gap-1 px-2 text-xs text-base-content/70">
        <UploadIcon aria-hidden="true" />
        <span class="hidden @xl:inline">{{ t('ui.files.FileToolbar.upload') }}</span>
      </Button>

      <!-- Paste -->
      <Button variant="ghost" size="sm" v-if="clipboard && currentPath" @click.stop="emit('paste')" :tooltip="t('ui.files.FileToolbar.paste')" :aria-label="t('ui.files.FileToolbar.pasteFiles')"
        :class="['gap-1 px-2 text-xs',
          clipboard.mode === 'cut'
            ? 'bg-warning/15 text-warning hover:bg-warning/25 hover:text-warning'
            : 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary']">
        <ClipboardPasteIcon aria-hidden="true" />
        <span class="hidden @xl:inline">{{ t('uip.files.FileToolbar.paste', { p0: clipboard.mode === 'cut' ? '(move)' : '', p1: clipboard.paths.length > 1 ? clipboard.paths.length + ' items' : '' }) }}</span>
      </Button>

      <!-- Divider -->
      <Separator v-if="currentPath" orientation="vertical" class="hidden @xl:block data-[orientation=vertical]:h-4 mx-1" />

      <!-- Refresh: on a phone it stays in the long-press menu, so the actions fit on one row. -->
      <Button variant="ghost" size="icon-sm" v-if="currentPath" @click="emit('refresh')" :tooltip="t('ui.files.FileToolbar.refresh')" :aria-label="t('ui.files.FileToolbar.refreshFolder')"
        class="hidden @xl:inline-flex text-base-content/70 hover:text-base-content">
        <RefreshCwIcon class="w-4 h-4" aria-hidden="true" />
      </Button>

      <!-- Bookmark the current folder (#199) -->
      <Button v-if="currentPath" variant="ghost" size="sm"
        :tooltip="bookmarked ? t('files.bookmarks.remove') : t('files.bookmarks.add')"
        :aria-label="bookmarked ? t('files.bookmarks.remove') : t('files.bookmarks.add')"
        :aria-pressed="bookmarked"
        :class="['px-2', bookmarked ? 'text-primary' : 'text-base-content/70']"
        @click="emit('toggleBookmark')">
        <BookmarkIcon :class="bookmarked ? 'fill-current' : ''" aria-hidden="true" />
      </Button>

      <!-- Sort and hidden files (#196) -->
      <SortMenu @open-display-settings="emit('openDisplaySettings')" />

      <!-- View toggle -->
      <ToggleGroup
        type="single" variant="tabs" size="sm"
        :model-value="viewMode"
        :aria-label="t('ui.files.FileToolbar.viewMode')"
        @update:model-value="v => { if (v === 'list' || v === 'grid') emit('update:viewMode', v) }"
      >
        <Tip :text="t('ui.files.FileToolbar.listView')"><ToggleGroupItem value="list" :aria-label="t('ui.files.FileToolbar.listView')">
          <ListIcon class="size-4" aria-hidden="true" />
        </ToggleGroupItem></Tip>
        <Tip :text="t('ui.files.FileToolbar.gridView')"><ToggleGroupItem value="grid" :aria-label="t('ui.files.FileToolbar.gridView')">
          <LayoutGridIcon class="size-4" aria-hidden="true" />
        </ToggleGroupItem></Tip>
      </ToggleGroup>

      <!-- Search: collapsed to an icon until opened, so it doesn't permanently
           claim ~150px from the breadcrumb (tight in a narrow desktop-mode
           window, tighter still on a phone). -->
      <div v-if="currentPath" class="flex items-center ml-1 border-l border-base-300 pl-2">
        <Button variant="ghost" size="icon-sm" v-if="!searchOpen" @click="openSearch" :tooltip="t('ui.files.FileToolbar.search')" :aria-label="t('ui.files.FileToolbar.searchThisFolder')"
          class="text-base-content/70 hover:text-base-content">
          <SearchIcon class="w-4 h-4" aria-hidden="true" />
        </Button>
        <div v-else class="relative">
          <SearchIcon class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-base-content/70" aria-hidden="true" />
          <Input
            ref="searchInput"
            v-model="searchQuery"
            @keydown.enter="submitSearch"
            @keydown.escape="clearSearch"
            type="text"
            :placeholder="t('ui.files.FileToolbar.search2')"
            class="h-7 pl-6 pr-6 text-xs w-28 @xl:w-36"
          />
          <Button variant="ghost" size="icon-xs" @click="clearSearch" :tooltip="t('ui.files.FileToolbar.closeSearch')" :aria-label="t('ui.files.FileToolbar.closeSearch')"
            class="absolute right-0.5 top-1/2 -translate-y-1/2 size-5 text-base-content/70">
            <XIcon class="size-3" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  </div>
  </div>
</template>

