<script setup lang="ts">
import { onBeforeUnmount, toRef } from 'vue'
import { useProgressiveList } from '../../lib/progressive-list'
import { slowClick } from '../../lib/slow-click'
import { isTouchClick } from '../../lib/touch'
import { endFileDrag, useFolderDrop, type DropAction } from '../../lib/file-drag'
import { Checkbox } from '@/components/ui/checkbox'
import FileTypeIcon from './FileTypeIcon.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EyeIcon, PencilIcon } from '@lucide/vue'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import type { Transfer } from '../../lib/uploads'


type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }

const props = defineProps<{
  entries: Entry[]
  selected: Set<string>
  renamingPath: string | null
  renameValue: string
  pendingPaths?: string[]
  creatingFolder?: boolean
  creatingFile?: boolean
  uploadTasks?: Transfer[]
}>()

const emit = defineEmits<{
  dragStart: [entry: Entry, event: DragEvent]
  dropInto: [dir: string, paths: string[], action: DropAction]
  cardClick: [entry: Entry, event: MouseEvent]
  cardDblClick: [entry: Entry]
  selectEntry: [entry: Entry, event: MouseEvent]
  contextmenu: [entry: Entry, event: MouseEvent]
  startRename: [entry: Entry]
  commitRename: []
  cancelRename: []
  'update:renameValue': [value: string]
  openFile: [entry: Entry]
}>()

// A double click on the row opens; a click on the name of the item already
// selected alone renames it after a pause (a touch tap opens, the pencil renames).
// Only the items near the screen: a folder of thousands of files stays responsive.
const { visible, sentinel, hasMore } = useProgressiveList(toRef(props, 'entries'), toRef(props, 'selected'))
const setSentinel = (el: unknown) => { sentinel.value = el instanceof HTMLElement ? el : null }

const nameClick = slowClick()
onBeforeUnmount(() => nameClick.cancel())
function onNameClick(entry: Entry, e: MouseEvent) {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || isTouchClick(e)) return
  if (props.selected.size === 1 && props.selected.has(entry.path)) nameClick.arm(() => emit('startRename', entry))
}

// Folders take items dragged onto them (moved there).
const folderDrop = useFolderDrop((dir, paths, action) => emit('dropInto', dir, paths, action))


</script>

<template>
  <div class="p-3 grid gap-1" style="grid-template-columns: repeat(auto-fill, minmax(108px, 1fr))">
    <!-- Upload cards (progress lives in the Transfers tray; this is a placeholder) -->
    <div
      v-for="t in uploadTasks"
      :key="t.id"
      class="relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-box bg-base-200 select-none pointer-events-none overflow-hidden"
    >
      <!-- File icon -->
      <div class="w-11 h-11 relative flex items-center justify-center shrink-0">
        <FileTypeIcon :name="t.name" plain class="w-9 h-11 shrink-0" :class="t.status === 'error' ? 'text-error' : t.status === 'paused' ? 'text-warning' : 'text-primary'" aria-hidden="true" />
        <!-- Spinner overlay on icon -->
        <div v-if="t.status === 'uploading' || t.status === 'verifying' || t.status === 'queued' || t.status === 'running'" class="absolute inset-0 flex items-center justify-center">
          <LoadingSpinner class="text-xl text-primary drop-shadow" />
        </div>
      </div>

      <!-- Name -->
      <span class="text-xs leading-tight w-full text-center truncate px-1"
        :class="t.status === 'error' ? 'text-error' : 'text-base-content/80'"
        :title="t.name">
        {{ t.name }}
      </span>

      <span v-if="t.status === 'paused'" class="text-2xs text-warning">{{ $t('ui.files.FileGridView.paused') }}</span>
      <span v-else-if="t.status === 'error'" class="text-2xs text-error">{{ $t('ui.files.FileGridView.failed') }}</span>
    </div>

    <!-- Ghost card while creating a folder -->
    <div v-if="creatingFolder" class="relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-box bg-base-200 opacity-60 select-none pointer-events-none">
      <FileTypeIcon name="" dir class="w-11 h-11 shrink-0" aria-hidden="true" />
      <span class="text-xs text-base-content/70 italic">{{ $t('ui.files.FileGridView.newFolder') }}</span>
      <!-- Centered spinner overlay -->
      <div class="absolute inset-0 flex items-center justify-center rounded-box bg-base-100/30">
        <LoadingSpinner class="text-xl text-primary" />
      </div>
    </div>

    <!-- Ghost card while creating a file -->
    <div v-if="creatingFile" class="relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-box bg-base-200 opacity-60 select-none pointer-events-none">
      <FileTypeIcon name="" class="w-9 h-11 shrink-0" aria-hidden="true" />
      <span class="text-xs text-base-content/70 italic">{{ $t('ui.files.FileGridView.newFile') }}</span>
      <!-- Centered spinner overlay -->
      <div class="absolute inset-0 flex items-center justify-center rounded-box bg-base-100/30">
        <LoadingSpinner class="text-xl text-primary" />
      </div>
    </div>

    <div
      v-for="entry in visible"
      :key="entry.path"
      :data-path="entry.path"
      :draggable="renamingPath !== entry.path && !pendingPaths?.includes(entry.path)"
      @dragstart="emit('dragStart', entry, $event)"
      @dragend="endFileDrag()"
      @dragover="entry.type === 'dir' && folderDrop.onDragOver(entry.path, $event)"
      @dragleave="folderDrop.onDragLeave(entry.path)"
      @drop="entry.type === 'dir' && folderDrop.onDrop(entry.path, $event)"
      @click.stop="pendingPaths?.includes(entry.path) ? undefined : emit('cardClick', entry, $event)"
      @dblclick.stop="pendingPaths?.includes(entry.path) ? undefined : emit('cardDblClick', entry)"
      @contextmenu="pendingPaths?.includes(entry.path) ? ($event.preventDefault(), $event.stopPropagation()) : emit('contextmenu', entry, $event)"
      @mousedown.shift.prevent
      :class="[
        'group relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-box transition-colors select-none [-webkit-touch-callout:none] touch-manipulation',
        pendingPaths?.includes(entry.path)
          ? 'cursor-default pointer-events-none'
          : 'cursor-pointer',
        selected.has(entry.path) && !pendingPaths?.includes(entry.path)
          ? 'bg-primary/10 ring-1 ring-primary'
          : 'hover:bg-base-200',
        folderDrop.over.value === entry.path ? 'bg-primary/15 ring-2 ring-primary' : '',
      ]"
    >
      <!-- Pending overlay -->
      <div v-if="pendingPaths?.includes(entry.path)"
        class="absolute inset-0 z-10 flex items-center justify-center rounded-box bg-base-100/60">
        <LoadingSpinner class="text-xl text-base-content/70" />
      </div>

      <!-- Checkbox -->
      <Checkbox
        :model-value="selected.has(entry.path)"
        :aria-label="`Select ${entry.name}`"
        :class="['absolute top-1.5 left-1.5 bg-base-100 transition-opacity', selected.has(entry.path) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100']"
        @click.stop.prevent="emit('selectEntry', entry, $event)"
      />

      <!-- Rename: a touch screen has no double click on the name -->
      <Button
        v-if="renamingPath !== entry.path"
        variant="ghost" size="icon-xs"
        :aria-label="`${$t('ui.files.FileBrowserPanel.rename')} ${entry.name}`"
        class="absolute top-1 right-1 hidden pointer-coarse:inline-flex text-base-content/70"
        @click.stop="emit('startRename', entry)"
      >
        <PencilIcon class="size-3.5" aria-hidden="true" />
      </Button>

      <!-- Icon -->
      <FileTypeIcon v-if="entry.type === 'dir'" :name="entry.name" dir class="w-11 h-11 shrink-0" aria-hidden="true" />
      <div v-else class="w-11 h-11 relative flex items-center justify-center flex-shrink-0">
        <FileTypeIcon :name="entry.name" class="w-9 h-11" aria-hidden="true" />
        <Button
          variant="ghost" size="icon-xs"
          @click.stop="emit('openFile', entry)"
          :tooltip="$t('ui.files.FileGridView.preview')"
          :aria-label="`Preview ${entry.name}`"
          class="absolute -top-1 -right-1 text-base-content/70 opacity-0 hover:text-primary focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
        >
          <EyeIcon class="size-4" aria-hidden="true" />
        </Button>
      </div>

      <!-- Name / Rename -->
      <template v-if="renamingPath === entry.path">
        <Input
          :model-value="renameValue"
          @update:model-value="v => emit('update:renameValue', String(v))"
          @click.stop
          @keydown.enter="emit('commitRename')"
          @keydown.escape="emit('cancelRename')"
          @blur="emit('cancelRename')"
          @focus="($event.target as HTMLInputElement).select()"
          autofocus
          data-rename
          class="h-6 w-full border-primary px-1.5 py-0.5 text-center text-xs md:text-xs"
        />
      </template>
      <template v-else>
        <span
          @click="onNameClick(entry, $event)"
          class="text-xs leading-tight text-base-content/80 w-full text-center truncate px-1 hover:text-base-content transition-colors"
          :title="entry.name">
          {{ entry.name }}
        </span>
      </template>
    </div>
    <!-- The next items render as this comes near the end of the scroll area. -->
    <div v-if="hasMore" :ref="setSentinel" class="col-span-full h-px" aria-hidden="true" />
  </div>
</template>
