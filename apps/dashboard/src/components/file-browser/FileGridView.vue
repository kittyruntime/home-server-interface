<script setup lang="ts">
import type { Transfer } from '../../lib/uploads'

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }

defineProps<{
  entries: Entry[]
  selected: Set<string>
  renamingPath: string | null
  renameValue: string
  pendingPaths?: string[]
  creatingFolder?: boolean
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

function uploadPct(t: Transfer) {
  return (t.totalBytes ?? 0) > 0 ? Math.round((t.sentBytes ?? 0) / (t.totalBytes ?? 1) * 100) : 0
}
function uploadSpeed(bps: number) {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`
  if (bps >= 1_024)     return `${(bps / 1_024).toFixed(0)} KB/s`
  return bps > 0 ? `${Math.round(bps)} B/s` : ''
}
</script>

<template>
  <div class="p-3 grid gap-1" style="grid-template-columns: repeat(auto-fill, minmax(108px, 1fr))">
    <!-- Upload cards -->
    <div
      v-for="t in uploadTasks"
      :key="t.id"
      class="relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-xl bg-[var(--c-hover)] select-none pointer-events-none overflow-hidden"
    >
      <!-- File icon -->
      <div class="w-11 h-11 relative flex items-center justify-center shrink-0">
        <svg class="w-9 h-11 shrink-0"
          :class="t.status === 'error' ? 'text-[var(--c-danger)]' : t.status === 'paused' ? 'text-[var(--c-warning)]' : 'text-[var(--c-accent)]'"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.25">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
        </svg>
        <!-- Spinner overlay on icon -->
        <div v-if="t.status === 'uploading'" class="absolute inset-0 flex items-center justify-center">
          <svg class="w-5 h-5 animate-spin text-[var(--c-accent)] drop-shadow" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
            <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
          </svg>
        </div>
      </div>

      <!-- Name -->
      <span class="text-xs leading-tight w-full text-center truncate px-1"
        :class="t.status === 'error' ? 'text-[var(--c-danger)]' : 'text-[var(--c-text-2)]'"
        :title="t.name">
        {{ t.name }}
      </span>

      <!-- Speed badge -->
      <span v-if="t.status === 'uploading' && (t.bytesPerSec ?? 0) > 0"
        class="text-[9px] text-[var(--c-text-3)] tabular-nums leading-none">
        {{ uploadSpeed(t.bytesPerSec ?? 0) }}
      </span>
      <span v-else-if="t.status === 'paused'" class="text-[9px] text-[var(--c-warning)]">Paused</span>
      <span v-else-if="t.status === 'error'" class="text-[9px] text-[var(--c-danger)]">Failed</span>

      <!-- Progress bar at bottom -->
      <div v-if="t.status === 'uploading' || t.status === 'paused'"
        class="absolute bottom-0 left-0 right-0 h-1 bg-[var(--c-border)]">
        <div class="h-full transition-all duration-300"
          :class="t.status === 'paused' ? 'bg-[var(--c-warning)]' : 'bg-[var(--c-accent)]'"
          :style="{ width: uploadPct(t) + '%' }" />
      </div>
    </div>

    <!-- Ghost card while creating a folder -->
    <div v-if="creatingFolder" class="relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-xl bg-[var(--c-hover)] opacity-60 select-none pointer-events-none">
      <svg class="w-11 h-11 text-[var(--c-accent)] shrink-0" fill="currentColor" viewBox="0 0 24 24">
        <path d="M19.5 21a3 3 0 003-3v-4.5a3 3 0 00-3-3h-15a3 3 0 00-3 3V18a3 3 0 003 3h15zM1.5 10.146V6a3 3 0 013-3h5.379a2.25 2.25 0 011.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 013 3v1.146A4.483 4.483 0 0019.5 9h-15a4.483 4.483 0 00-3 1.146z"/>
      </svg>
      <span class="text-xs text-[var(--c-text-3)] italic">New Folder…</span>
      <!-- Centered spinner overlay -->
      <div class="absolute inset-0 flex items-center justify-center rounded-xl bg-[var(--c-bg)]/30">
        <svg class="w-5 h-5 animate-spin text-[var(--c-accent)]" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
        </svg>
      </div>
    </div>

    <div
      v-for="entry in entries"
      :key="entry.path"
      @click.stop="pendingPaths?.includes(entry.path) ? undefined : emit('cardClick', entry, $event)"
      @dblclick.stop="pendingPaths?.includes(entry.path) ? undefined : emit('cardDblClick', entry)"
      @contextmenu.prevent.stop="pendingPaths?.includes(entry.path) ? undefined : emit('contextmenu', entry, $event)"
      @mousedown.shift.prevent
      :class="[
        'group relative flex flex-col items-center gap-1.5 px-2 pt-3 pb-2.5 rounded-xl transition-colors select-none',
        pendingPaths?.includes(entry.path)
          ? 'cursor-default pointer-events-none'
          : 'cursor-pointer',
        selected.has(entry.path) && !pendingPaths?.includes(entry.path)
          ? 'bg-[var(--c-accent-subtle)] ring-1 ring-[var(--c-accent)]'
          : 'hover:bg-[var(--c-hover)]',
      ]"
    >
      <!-- Pending overlay -->
      <div v-if="pendingPaths?.includes(entry.path)"
        class="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-[var(--c-bg)]/60">
        <svg class="w-5 h-5 animate-spin text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
        </svg>
      </div>

      <!-- Checkbox -->
      <div
        @click.stop="emit('selectEntry', entry, $event)"
        :class="['absolute top-1.5 left-1.5 w-4 h-4 rounded border flex items-center justify-center transition-all',
          selected.has(entry.path)
            ? 'opacity-100 bg-[var(--c-accent)] border-[var(--c-accent)]'
            : 'opacity-0 group-hover:opacity-60 border-[var(--c-border-strong)] bg-[var(--c-surface-deep)]']">
        <svg v-if="selected.has(entry.path)" class="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
        </svg>
      </div>

      <!-- Icon -->
      <svg v-if="entry.type === 'dir'" class="w-11 h-11 text-[var(--c-accent)] shrink-0" fill="currentColor" viewBox="0 0 24 24">
        <path d="M19.5 21a3 3 0 003-3v-4.5a3 3 0 00-3-3h-15a3 3 0 00-3 3V18a3 3 0 003 3h15zM1.5 10.146V6a3 3 0 013-3h5.379a2.25 2.25 0 011.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 013 3v1.146A4.483 4.483 0 0019.5 9h-15a4.483 4.483 0 00-3 1.146z"/>
      </svg>
      <div v-else class="w-11 h-11 relative flex items-center justify-center flex-shrink-0">
        <svg class="w-9 h-11 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.25">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
        </svg>
        <span v-if="fileExt(entry.name)" class="absolute bottom-0.5 text-[8px] font-bold text-[var(--c-text-3)] bg-[var(--c-bg)] px-1 rounded-sm leading-tight">
          {{ fileExt(entry.name) }}
        </span>
        <button
          @click.stop="emit('openFile', entry)"
          title="Preview"
          class="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-[var(--c-text-3)] hover:text-[var(--c-accent)] transition-all"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
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
          class="text-xs bg-[var(--c-bg)] border border-[var(--c-accent)] rounded-sm px-1.5 py-0.5 text-[var(--c-text-1)] focus:outline-none w-full text-center"
        />
      </template>
      <template v-else>
        <span
          @dblclick.stop="emit('startRename', entry)"
          class="text-xs leading-tight text-[var(--c-text-2)] w-full text-center truncate px-1 hover:text-white transition-colors"
          :title="entry.name">
          {{ entry.name }}
        </span>
      </template>
    </div>
  </div>
</template>
