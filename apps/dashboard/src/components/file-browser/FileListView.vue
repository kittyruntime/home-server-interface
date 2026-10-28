<script setup lang="ts">
import FileTypeIcon from './FileTypeIcon.vue'
import { Button } from '@/components/ui/button'
import SortableHeader from '../ui/SortableHeader.vue'
import { Input } from '@/components/ui/input'
import { EyeIcon, FileTextIcon, FolderIcon } from '@lucide/vue'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import { formatDay } from '../../lib/format-date'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import type { Transfer } from '../../lib/uploads'

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }
type SortField = 'name' | 'size' | 'date'

defineProps<{
  entries: Entry[]
  selected: Set<string>
  renamingPath: string | null
  renameValue: string
  pendingPaths?: string[]
  creatingFolder?: boolean
  creatingFile?: boolean
  uploadTasks?: Transfer[]
  sortField?: SortField
  sortDir?: 'asc' | 'desc'
}>()

const emit = defineEmits<{
  rowClick: [entry: Entry, event: MouseEvent]
  rowDblClick: [entry: Entry]
  selectEntry: [entry: Entry, event: MouseEvent]
  contextmenu: [entry: Entry, event: MouseEvent]
  startRename: [entry: Entry]
  commitRename: []
  cancelRename: []
  'update:renameValue': [value: string]
  selectAll: []
  clearSelection: []
  openFile: [entry: Entry]
  setSort: [field: SortField]
}>()

function formatSize(bytes: number | null): string {
  if (bytes === null) return '-'
  if (bytes === 0)    return '0 B'
  if (bytes < 1024)   return bytes + ' B'
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return (bytes / 1024 ** 3).toFixed(2) + ' GB'
}


function fileExt(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toUpperCase() : ''
}
</script>

<template>
  <!-- Mobile: cards instead of a table that has nowhere to shrink to. -->
  <div class="sm:hidden divide-y divide-border">
    <div v-for="t in uploadTasks" :key="t.id" class="flex items-center gap-2.5 px-3 py-2.5 min-w-0">
      <FileTypeIcon :name="t.name" class="w-4 h-4 shrink-0" :class="t.status === 'error' ? 'text-destructive' : t.status === 'paused' ? 'text-warning' : 'text-muted-foreground'" aria-hidden="true" />
      <span class="flex-1 min-w-0 truncate text-sm select-none" :class="t.status === 'error' ? 'text-destructive' : 'text-foreground/80'">{{ t.name }}</span>
      <span v-if="t.status === 'error'" class="text-2xs text-destructive shrink-0">{{ t.error }}</span>
      <span v-else-if="t.status === 'paused'" class="text-2xs text-warning shrink-0">Paused</span>
      <LoadingSpinner v-else-if="t.status === 'uploading' || t.status === 'verifying' || t.status === 'queued' || t.status === 'running'" class="text-sm text-muted-foreground shrink-0" />
    </div>

    <div v-if="creatingFolder" class="flex items-center gap-2.5 px-3 py-2.5 opacity-60">
      <FolderIcon class="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
      <span class="flex-1 text-sm italic text-muted-foreground select-none">New Folder…</span>
      <LoadingSpinner class="text-sm text-muted-foreground shrink-0" />
    </div>
    <div v-if="creatingFile" class="flex items-center gap-2.5 px-3 py-2.5 opacity-60">
      <FileTextIcon class="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
      <span class="flex-1 text-sm italic text-muted-foreground select-none">New File…</span>
      <LoadingSpinner class="text-sm text-muted-foreground shrink-0" />
    </div>

    <article
      v-for="entry in entries"
      :key="entry.path"
      @click.stop="pendingPaths?.includes(entry.path) ? undefined : emit('rowClick', entry, $event)"
      @contextmenu="pendingPaths?.includes(entry.path) ? ($event.preventDefault(), $event.stopPropagation()) : emit('contextmenu', entry, $event)"
      :class="['relative flex items-center gap-2.5 px-3 py-2.5 min-w-0 transition-colors',
        pendingPaths?.includes(entry.path) ? 'opacity-40 pointer-events-none' : '',
        selected.has(entry.path) && !pendingPaths?.includes(entry.path) ? 'bg-primary/10' : 'active:bg-accent']"
    >
      <div
        @click.stop="emit('selectEntry', entry, $event)"
        :class="['touch-target -m-2 grid shrink-0 place-items-center', selected.has(entry.path) ? '' : 'opacity-50']"
        :aria-label="`Select ${entry.name}`"
      >
        <Checkbox :model-value="selected.has(entry.path)" tabindex="-1" aria-hidden="true" class="pointer-events-none" />
      </div>

      <FolderIcon v-if="entry.type === 'dir'" class="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
      <FileTypeIcon v-else :name="entry.name" class="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />

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
          class="min-w-0 flex-1 rounded-sm border border-primary bg-background px-2 py-0.5 text-sm text-foreground focus:outline-none"
        />
      </template>
      <div v-else class="min-w-0 flex-1">
        <div class="truncate text-sm select-none" :class="entry.type === 'dir' ? 'text-foreground' : 'text-foreground/80'">{{ entry.name }}</div>
        <div v-if="entry.type === 'file'" class="text-2xs text-muted-foreground font-mono tabular-nums">
          {{ formatSize(entry.size) }} · {{ formatDay(entry.mtime) }}
        </div>
      </div>
      <LoadingSpinner v-if="pendingPaths?.includes(entry.path)" class="text-sm shrink-0 text-muted-foreground" />
    </article>
  </div>

  <!-- Desktop / tablet: sortable table -->
  <Table container-class="hidden sm:block overflow-visible" class="w-full text-sm">
    <TableHeader class="sticky top-0 bg-background border-b border-border z-10">
      <TableRow class="text-left text-xs uppercase tracking-caps text-muted-foreground">
        <TableHead class="pl-3 pr-1 py-2.5 w-7">
          <Checkbox
            :model-value="selected.size > 0 && selected.size < entries.length ? 'indeterminate' : selected.size === entries.length && entries.length > 0"
            aria-label="Select all"
            class="opacity-60 hover:opacity-100 transition-opacity"
            @click.stop
            @update:model-value="selected.size > 0 ? emit('clearSelection') : emit('selectAll')"
          />
        </TableHead>
        <TableHead class="px-3 py-2.5 font-medium">
          <SortableHeader :active="sortField === 'name'" :dir="sortDir ?? 'asc'"  @click="emit('setSort', 'name')">Name</SortableHeader>
        </TableHead>
        <TableHead class="px-3 py-2.5 font-medium text-right">
          <SortableHeader :active="sortField === 'size'" :dir="sortDir ?? 'asc'" class="ml-auto" @click="emit('setSort', 'size')">Size</SortableHeader>
        </TableHead>
        <TableHead class="px-3 py-2.5 font-medium text-right">
          <SortableHeader :active="sortField === 'date'" :dir="sortDir ?? 'asc'" class="ml-auto" @click="emit('setSort', 'date')">Modified</SortableHeader>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody class="divide-y divide-border">
      <!-- Upload rows (progress lives in the Transfers tray; this is a placeholder) -->
      <TableRow v-for="t in uploadTasks" :key="t.id" class="group">
        <TableCell class="pl-3 pr-1 py-2.5 w-7" />
        <TableCell class="px-3 py-2.5" colspan="3">
          <div class="flex items-center gap-2.5 min-w-0">
            <FileTypeIcon :name="t.name" class="w-4 h-4 shrink-0" :class="t.status === 'error' ? 'text-destructive' : t.status === 'paused' ? 'text-warning' : 'text-muted-foreground'" aria-hidden="true" />
            <span class="text-sm truncate select-none"
              :class="t.status === 'error' ? 'text-destructive' : 'text-foreground/80'">
              {{ t.name }}
            </span>
            <span v-if="t.status === 'error'" class="text-2xs text-destructive shrink-0">{{ t.error }}</span>
            <span v-else-if="t.status === 'paused'" class="text-2xs text-warning shrink-0">Paused</span>
            <LoadingSpinner v-else-if="t.status === 'uploading' || t.status === 'verifying' || t.status === 'queued' || t.status === 'running'" class="text-sm text-muted-foreground shrink-0" />
          </div>
        </TableCell>
      </TableRow>

      <!-- Ghost row while creating a folder -->
      <TableRow v-if="creatingFolder" class="opacity-60">
        <TableCell class="pl-3 pr-1 py-2.5 w-7" />
        <TableCell class="px-3 py-2.5">
          <div class="flex items-center gap-2.5">
            <FolderIcon class="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
            <span class="text-muted-foreground text-sm italic select-none">New Folder…</span>
            <LoadingSpinner class="text-sm text-muted-foreground shrink-0" />
          </div>
        </TableCell>
        <TableCell /><TableCell />
      </TableRow>

      <!-- Ghost row while creating a file -->
      <TableRow v-if="creatingFile" class="opacity-60">
        <TableCell class="pl-3 pr-1 py-2.5 w-7" />
        <TableCell class="px-3 py-2.5">
          <div class="flex items-center gap-2.5">
            <FileTextIcon class="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
            <span class="text-muted-foreground text-sm italic select-none">New File…</span>
            <LoadingSpinner class="text-sm text-muted-foreground shrink-0" />
          </div>
        </TableCell>
        <TableCell /><TableCell />
      </TableRow>

      <TableRow
        v-for="entry in entries"
        :key="entry.path"
        @click.stop="pendingPaths?.includes(entry.path) ? undefined : emit('rowClick', entry, $event)"
        @dblclick.stop="pendingPaths?.includes(entry.path) ? undefined : emit('rowDblClick', entry)"
        @contextmenu="pendingPaths?.includes(entry.path) ? ($event.preventDefault(), $event.stopPropagation()) : emit('contextmenu', entry, $event)"
        @mousedown.shift.prevent
        :class="['group transition-colors',
          pendingPaths?.includes(entry.path)
            ? 'opacity-40 pointer-events-none'
            : entry.type === 'dir' ? 'cursor-pointer hover:bg-accent' : 'cursor-default hover:bg-accent',
          selected.has(entry.path) && !pendingPaths?.includes(entry.path) ? 'bg-primary/10' : '']"
      >
        <!-- Checkbox -->
        <TableCell class="pl-3 pr-1 py-2.5 w-7" @click.stop>
          <Checkbox
            :model-value="selected.has(entry.path)"
            :aria-label="`Select ${entry.name}`"
            :class="['transition-opacity', selected.has(entry.path) ? 'opacity-100' : 'opacity-0 group-hover:opacity-50 focus-visible:opacity-100']"
            @click.prevent="emit('selectEntry', entry, $event)"
          />
        </TableCell>

        <!-- Name -->
        <TableCell class="px-3 py-2.5">
          <div class="flex items-center gap-2.5">
            <FolderIcon v-if="entry.type === 'dir'" class="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
            <FileTypeIcon v-else :name="entry.name" class="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />

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
                class="h-7 min-w-0 flex-1 border-primary px-2 py-0.5"
              />
            </template>
            <template v-else>
              <span
                @dblclick.stop="emit('startRename', entry)"
                :title="entry.name"
                :class="['transition-colors truncate select-none',
                  entry.type === 'dir'
                    ? 'text-foreground hover:text-primary'
                    : 'text-foreground/80 hover:text-foreground']">
                {{ entry.name }}
              </span>
              <span v-if="entry.type === 'file' && fileExt(entry.name)" class="text-muted-foreground text-2xs font-mono shrink-0">
                {{ fileExt(entry.name) }}
              </span>
              <Button
                v-if="entry.type === 'file'"
                variant="ghost" size="icon-xs"
                @click.stop="emit('openFile', entry)"
                tooltip="Preview"
                :aria-label="`Preview ${entry.name}`"
                class="shrink-0 text-muted-foreground opacity-0 hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
              >
                <EyeIcon class="size-4" aria-hidden="true" />
              </Button>
            </template>
          </div>
        </TableCell>

        <TableCell class="px-3 py-2.5 text-right text-muted-foreground font-mono text-xs tabular-nums">
          <LoadingSpinner v-if="pendingPaths?.includes(entry.path)" class="text-sm ml-auto text-muted-foreground" />
          <template v-else>{{ formatSize(entry.size) }}</template>
        </TableCell>
        <TableCell class="px-3 py-2.5 text-right text-muted-foreground text-xs tabular-nums">{{ formatDay(entry.mtime) }}</TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
