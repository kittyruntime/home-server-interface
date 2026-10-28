<script setup lang="ts">
import { Checkbox } from '@/components/ui/checkbox'
import FileTypeIcon from './FileTypeIcon.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EyeIcon, FileIcon, FolderIcon } from '@lucide/vue'
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
        <FileTypeIcon :name="t.name" class="w-9 h-11 shrink-0" :class="t.status === 'error' ? 'text-destructive' : t.status === 'paused' ? 'text-warning' : 'text-primary'" aria-hidden="true" />
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
      <Checkbox
        :model-value="selected.has(entry.path)"
        :aria-label="`Select ${entry.name}`"
        :class="['absolute top-1.5 left-1.5 bg-background transition-opacity', selected.has(entry.path) ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 focus-visible:opacity-100']"
        @click.stop.prevent="emit('selectEntry', entry, $event)"
      />

      <!-- Icon -->
      <FileTypeIcon v-if="entry.type === 'dir'" :name="entry.name" dir class="w-11 h-11 text-primary shrink-0" aria-hidden="true" />
      <div v-else class="w-11 h-11 relative flex items-center justify-center flex-shrink-0">
        <FileTypeIcon :name="entry.name" class="w-9 h-11 text-muted-foreground" aria-hidden="true" />
        <Button
          variant="ghost" size="icon-xs"
          @click.stop="emit('openFile', entry)"
          tooltip="Preview"
          :aria-label="`Preview ${entry.name}`"
          class="absolute -top-1 -right-1 text-muted-foreground opacity-0 hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
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
          class="h-6 w-full border-primary px-1.5 py-0.5 text-center text-xs md:text-xs"
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
