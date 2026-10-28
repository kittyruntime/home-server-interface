<script setup lang="ts">
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
      <svg class="w-4 h-4 shrink-0"
        :class="t.status === 'error' ? 'text-destructive' : t.status === 'paused' ? 'text-warning' : 'text-muted-foreground'"
        fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>
      <span class="flex-1 min-w-0 truncate text-sm select-none" :class="t.status === 'error' ? 'text-destructive' : 'text-foreground/80'">{{ t.name }}</span>
      <span v-if="t.status === 'error'" class="text-2xs text-destructive shrink-0">{{ t.error }}</span>
      <span v-else-if="t.status === 'paused'" class="text-2xs text-warning shrink-0">Paused</span>
      <LoadingSpinner v-else-if="t.status === 'uploading' || t.status === 'verifying' || t.status === 'queued' || t.status === 'running'" class="text-sm text-muted-foreground shrink-0" />
    </div>

    <div v-if="creatingFolder" class="flex items-center gap-2.5 px-3 py-2.5 opacity-60">
      <svg class="w-4 h-4 text-primary shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
      </svg>
      <span class="flex-1 text-sm italic text-muted-foreground select-none">New Folder…</span>
      <LoadingSpinner class="text-sm text-muted-foreground shrink-0" />
    </div>
    <div v-if="creatingFile" class="flex items-center gap-2.5 px-3 py-2.5 opacity-60">
      <svg class="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>
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
        <div :class="['w-4 h-4 rounded border flex items-center justify-center',
          selected.has(entry.path) ? 'bg-primary border-primary' : 'border-input']">
          <svg v-if="selected.has(entry.path)" class="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
        </div>
      </div>

      <svg v-if="entry.type === 'dir'" class="w-4 h-4 text-primary shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
      </svg>
      <svg v-else class="w-4 h-4 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>

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
  <table class="hidden w-full text-sm sm:table">
    <thead class="sticky top-0 bg-background border-b border-border z-10">
      <tr class="text-left text-xs uppercase tracking-caps text-muted-foreground">
        <th class="pl-3 pr-1 py-2.5 w-7">
          <input type="checkbox"
            :checked="selected.size === entries.length && entries.length > 0"
            :indeterminate="selected.size > 0 && selected.size < entries.length"
            @change="selected.size > 0 ? emit('clearSelection') : emit('selectAll')"
            class="w-3.5 h-3.5 rounded accent-primary cursor-pointer opacity-40 hover:opacity-90 transition-opacity"
          />
        </th>
        <th class="px-3 py-2.5 font-medium">
          <button @click="emit('setSort', 'name')" class="flex items-center gap-1 hover:text-foreground transition-colors">
            Name
            <span class="w-3 inline-flex justify-center">
              <svg v-if="sortField === 'name'" class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" :d="sortDir === 'asc' ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'"/>
              </svg>
            </span>
          </button>
        </th>
        <th class="px-3 py-2.5 font-medium text-right">
          <button @click="emit('setSort', 'size')" class="flex items-center gap-1 ml-auto hover:text-foreground transition-colors">
            <span class="w-3 inline-flex justify-center">
              <svg v-if="sortField === 'size'" class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" :d="sortDir === 'asc' ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'"/>
              </svg>
            </span>
            Size
          </button>
        </th>
        <th class="px-3 py-2.5 font-medium text-right">
          <button @click="emit('setSort', 'date')" class="flex items-center gap-1 ml-auto hover:text-foreground transition-colors">
            <span class="w-3 inline-flex justify-center">
              <svg v-if="sortField === 'date'" class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" :d="sortDir === 'asc' ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'"/>
              </svg>
            </span>
            Modified
          </button>
        </th>
      </tr>
    </thead>
    <tbody class="divide-y divide-border">
      <!-- Upload rows (progress lives in the Transfers tray; this is a placeholder) -->
      <tr v-for="t in uploadTasks" :key="t.id" class="group">
        <td class="pl-3 pr-1 py-2.5 w-7" />
        <td class="px-3 py-2.5" colspan="3">
          <div class="flex items-center gap-2.5 min-w-0">
            <svg class="w-4 h-4 shrink-0"
              :class="t.status === 'error' ? 'text-destructive' : t.status === 'paused' ? 'text-warning' : 'text-muted-foreground'"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            <span class="text-sm truncate select-none"
              :class="t.status === 'error' ? 'text-destructive' : 'text-foreground/80'">
              {{ t.name }}
            </span>
            <span v-if="t.status === 'error'" class="text-2xs text-destructive shrink-0">{{ t.error }}</span>
            <span v-else-if="t.status === 'paused'" class="text-2xs text-warning shrink-0">Paused</span>
            <LoadingSpinner v-else-if="t.status === 'uploading' || t.status === 'verifying' || t.status === 'queued' || t.status === 'running'" class="text-sm text-muted-foreground shrink-0" />
          </div>
        </td>
      </tr>

      <!-- Ghost row while creating a folder -->
      <tr v-if="creatingFolder" class="opacity-60">
        <td class="pl-3 pr-1 py-2.5 w-7" />
        <td class="px-3 py-2.5">
          <div class="flex items-center gap-2.5">
            <svg class="w-4 h-4 text-primary shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
            </svg>
            <span class="text-muted-foreground text-sm italic select-none">New Folder…</span>
            <LoadingSpinner class="text-sm text-muted-foreground shrink-0" />
          </div>
        </td>
        <td /><td />
      </tr>

      <!-- Ghost row while creating a file -->
      <tr v-if="creatingFile" class="opacity-60">
        <td class="pl-3 pr-1 py-2.5 w-7" />
        <td class="px-3 py-2.5">
          <div class="flex items-center gap-2.5">
            <svg class="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            <span class="text-muted-foreground text-sm italic select-none">New File…</span>
            <LoadingSpinner class="text-sm text-muted-foreground shrink-0" />
          </div>
        </td>
        <td /><td />
      </tr>

      <tr
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
        <td class="pl-3 pr-1 py-2.5 w-7" @click.stop>
          <div
            @click="emit('selectEntry', entry, $event)"
            :class="['w-4 h-4 rounded border flex items-center justify-center transition-all cursor-pointer',
              selected.has(entry.path)
                ? 'bg-primary border-primary opacity-100'
                : 'border-input bg-transparent opacity-0 group-hover:opacity-50']">
            <svg v-if="selected.has(entry.path)" class="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
          </div>
        </td>

        <!-- Name -->
        <td class="px-3 py-2.5">
          <div class="flex items-center gap-2.5">
            <svg v-if="entry.type === 'dir'" class="w-4 h-4 text-primary shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
            </svg>
            <svg v-else class="w-4 h-4 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>

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
                class="bg-background border border-primary rounded-sm px-2 py-0.5 text-sm text-foreground focus:outline-none flex-1 min-w-0"
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
              <button
                v-if="entry.type === 'file'"
                @click.stop="emit('openFile', entry)"
                title="Preview"
                class="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all shrink-0"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
              </button>
            </template>
          </div>
        </td>

        <td class="px-3 py-2.5 text-right text-muted-foreground font-mono text-xs tabular-nums">
          <LoadingSpinner v-if="pendingPaths?.includes(entry.path)" class="text-sm ml-auto text-muted-foreground" />
          <template v-else>{{ formatSize(entry.size) }}</template>
        </td>
        <td class="px-3 py-2.5 text-right text-muted-foreground text-xs tabular-nums">{{ formatDay(entry.mtime) }}</td>
      </tr>
    </tbody>
  </table>
</template>
