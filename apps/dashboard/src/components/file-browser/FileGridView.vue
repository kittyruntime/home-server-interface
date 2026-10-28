<script setup lang="ts">
import { CheckIcon, EyeIcon, FileIcon, FolderIcon } from '@lucide/vue'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import type { Transfer } from '../../lib/uploads'

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }

defineProps<{
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

function fileExt(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toUpperCase() : ''
}

</script>

<template>
  <div class="p-3 grid gap-1" style="grid-template-columns: repeat(auto-fill, minmax(108px, 1fr))">
    <!-- Upload cards (progress lives in the Transfers tray; this is a placeholder) -->
    <div
      v-for="t in uploadTasks"
      :key="t.id"
      class="relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-xl bg-accent select-none pointer-events-none overflow-hidden"
    >
      <!-- File icon -->
      <div class="w-11 h-11 relative flex items-center justify-center shrink-0">
        <FileIcon class="w-9 h-11 shrink-0" :class="t.status === 'error' ? 'text-destructive' : t.status === 'paused' ? 'text-warning' : 'text-primary'" aria-hidden="true" />
        <!-- Spinner overlay on icon -->
        <div v-if="t.status === 'uploading' || t.status === 'verifying' || t.status === 'queued' || t.status === 'running'" class="absolute inset-0 flex items-center justify-center">
          <LoadingSpinner class="text-xl text-primary drop-shadow" />
        </div>
      </div>

      <!-- Name -->
      <span class="text-xs leading-tight w-full text-center truncate px-1"
        :class="t.status === 'error' ? 'text-destructive' : 'text-foreground/80'"
        :title="t.name">
        {{ t.name }}
      </span>

      <span v-if="t.status === 'paused'" class="text-2xs text-warning">Paused</span>
      <span v-else-if="t.status === 'error'" class="text-2xs text-destructive">Failed</span>
    </div>

    <!-- Ghost card while creating a folder -->
    <div v-if="creatingFolder" class="relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-xl bg-accent opacity-60 select-none pointer-events-none">
      <FolderIcon class="w-11 h-11 text-primary shrink-0" aria-hidden="true" />
      <span class="text-xs text-muted-foreground italic">New Folder…</span>
      <!-- Centered spinner overlay -->
      <div class="absolute inset-0 flex items-center justify-center rounded-xl bg-background/30">
        <LoadingSpinner class="text-xl text-primary" />
      </div>
    </div>

    <!-- Ghost card while creating a file -->
    <div v-if="creatingFile" class="relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-xl bg-accent opacity-60 select-none pointer-events-none">
      <FileIcon class="w-11 h-11 text-primary shrink-0" aria-hidden="true" />
      <span class="text-xs text-muted-foreground italic">New File…</span>
      <!-- Centered spinner overlay -->
      <div class="absolute inset-0 flex items-center justify-center rounded-xl bg-background/30">
        <LoadingSpinner class="text-xl text-primary" />
      </div>
    </div>

    <div
      v-for="entry in entries"
      :key="entry.path"
      @click.stop="pendingPaths?.includes(entry.path) ? undefined : emit('cardClick', entry, $event)"
      @dblclick.stop="pendingPaths?.includes(entry.path) ? undefined : emit('cardDblClick', entry)"
      @contextmenu="pendingPaths?.includes(entry.path) ? ($event.preventDefault(), $event.stopPropagation()) : emit('contextmenu', entry, $event)"
      @mousedown.shift.prevent
      :class="[
        'group relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-xl transition-colors select-none',
        pendingPaths?.includes(entry.path)
          ? 'cursor-default pointer-events-none'
          : 'cursor-pointer',
        selected.has(entry.path) && !pendingPaths?.includes(entry.path)
          ? 'bg-primary/10 ring-1 ring-primary'
          : 'hover:bg-accent',
      ]"
    >
      <!-- Pending overlay -->
      <div v-if="pendingPaths?.includes(entry.path)"
        class="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/60">
        <LoadingSpinner class="text-xl text-muted-foreground" />
      </div>

      <!-- Checkbox -->
      <div
        @click.stop="emit('selectEntry', entry, $event)"
        :class="['absolute top-1.5 left-1.5 w-4 h-4 rounded border flex items-center justify-center transition-all',
          selected.has(entry.path)
            ? 'opacity-100 bg-primary border-primary'
            : 'opacity-0 group-hover:opacity-60 border-input bg-muted']">
        <CheckIcon v-if="selected.has(entry.path)" class="w-2.5 h-2.5 text-white" aria-hidden="true" />
      </div>

      <!-- Icon -->
      <FolderIcon v-if="entry.type === 'dir'" class="w-11 h-11 text-primary shrink-0" aria-hidden="true" />
      <div v-else class="w-11 h-11 relative flex items-center justify-center flex-shrink-0">
        <FileIcon class="w-9 h-11 text-muted-foreground" aria-hidden="true" />
        <span v-if="fileExt(entry.name)" class="absolute bottom-0.5 text-2xs font-bold text-muted-foreground bg-background px-1 rounded-sm leading-tight">
          {{ fileExt(entry.name) }}
        </span>
        <button
          @click.stop="emit('openFile', entry)"
          title="Preview"
          class="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all"
        >
          <EyeIcon class="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      <!-- Name / Rename -->
      <template v-if="renamingPath === entry.path">
        <input
          :value="renameValue"
          @input="emit('update:renameValue', ($event.target as HTMLInputElement).value)"
          @click.stop
          @keydown.enter="emit('commitRename')"
          @keydown.escape="emit('cancelRename')"
          @blur="emit('cancelRename')"
          @focus="($event.target as HTMLInputElement).select()"
          autofocus
          class="text-xs bg-background border border-primary rounded-sm px-1.5 py-0.5 text-foreground focus:outline-none w-full text-center"
        />
      </template>
      <template v-else>
        <span
          @dblclick.stop="emit('startRename', entry)"
          class="text-xs leading-tight text-foreground/80 w-full text-center truncate px-1 hover:text-foreground transition-colors"
          :title="entry.name">
          {{ entry.name }}
        </span>
      </template>
    </div>
  </div>
</template>
