<script setup lang="ts">
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
  delete: []
  createFolder: []
  uploadClick: []
  paste: []
  refresh: []
  'update:viewMode': [mode: 'list' | 'grid']
  toggleSidebar: []
}>()
</script>

<template>
  <div
    class="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--c-border)] bg-[var(--c-surface-alt)]/60 backdrop-blur-sm flex-shrink-0 h-11"
    @click.stop
  >
    <!-- Mobile: places sidebar toggle -->
    <button @click="emit('toggleSidebar')" title="Places"
      class="sm:hidden p-1.5 rounded-lg flex-shrink-0 transition-colors"
      :class="sidebarOpen ? 'text-[var(--c-accent)] bg-[var(--c-accent-subtle)]' : 'text-slate-500 hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)]'">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
      </svg>
    </button>

    <!-- Back / Up -->
    <button v-if="canGoUp" @click="emit('goUp')" title="Go up"
      class="p-1.5 rounded-lg text-slate-500 hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors flex-shrink-0">
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
      </svg>
    </button>

    <!-- Breadcrumb -->
    <nav v-if="currentPath" class="flex items-center gap-0.5 text-sm flex-1 min-w-0 overflow-x-auto">
      <template v-for="(crumb, i) in breadcrumbs" :key="i">
        <span v-if="i > 0" class="text-slate-700 select-none mx-0.5 flex-shrink-0">›</span>
        <button v-if="crumb.clickable" @click="emit('navigate', crumb.path)"
          class="px-1 py-0.5 text-slate-400 hover:text-[var(--c-text-1)] rounded hover:bg-[var(--c-hover)] transition-colors whitespace-nowrap flex-shrink-0">
          {{ crumb.label }}
        </button>
        <span v-else class="px-1 text-[var(--c-text-1)] whitespace-nowrap flex-shrink-0 truncate">{{ crumb.label }}</span>
      </template>
    </nav>
    <div v-else class="flex-1" />

    <!-- Right-side actions -->
    <div class="flex items-center gap-0.5 flex-shrink-0 ml-auto">

      <!-- Selection actions -->
      <template v-if="selectedCount > 0">
        <span class="text-xs tabular-nums text-slate-500 select-none pl-1 pr-0.5">{{ selectedCount }} sel.</span>
        <button @click="emit('clearSelection')" title="Clear selection"
          class="p-1 rounded text-slate-600 hover:text-[var(--c-text-2)] transition-colors">
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
        <div class="w-px h-3.5 bg-slate-800 mx-0.5 flex-shrink-0" />

        <button @click="emit('copy')" title="Copy" class="sel-btn">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
          </svg>
        </button>
        <button @click="emit('cut')" title="Cut" class="sel-btn">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"/>
          </svg>
        </button>

        <template v-if="selectedCount === 1">
          <button @click="emit('startRename', selectedEntries[0]!)" title="Rename" class="sel-btn">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
            </svg>
          </button>
          <button v-if="selectedEntries[0]?.type === 'file'" @click="emit('download')" title="Download" class="sel-btn">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
          </button>
          <button @click="emit('openPermissions')" title="Permissions" class="sel-btn">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
            </svg>
          </button>
        </template>

        <button @click="emit('delete')" title="Delete" class="sel-btn sel-btn-danger">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
        </button>
        <div class="w-px h-3.5 bg-slate-800 mx-0.5 flex-shrink-0" />
      </template>

      <!-- New Folder -->
      <button v-if="currentPath" @click="emit('createFolder')" title="New Folder"
        class="flex items-center gap-1 px-2 py-1.5 rounded-lg text-slate-500 hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors text-xs">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
        </svg>
        <span class="hidden sm:inline">New folder</span>
      </button>

      <!-- Upload -->
      <button v-if="currentPath" @click="emit('uploadClick')" title="Upload files"
        class="flex items-center gap-1 px-2 py-1.5 rounded-lg text-slate-500 hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors text-xs">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
        </svg>
        <span class="hidden sm:inline">Upload</span>
      </button>

      <!-- Paste -->
      <button v-if="clipboard && currentPath" @click.stop="emit('paste')" title="Paste"
        :class="['flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors',
          clipboard.mode === 'cut'
            ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
            : 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)] hover:opacity-80']">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
        </svg>
        <span class="hidden sm:inline">Paste {{ clipboard.mode === 'cut' ? '(move)' : '' }} {{ clipboard.paths.length > 1 ? clipboard.paths.length + ' items' : '' }}</span>
      </button>

      <!-- Divider -->
      <div v-if="currentPath" class="w-px h-4 bg-slate-800 mx-1" />

      <!-- Refresh -->
      <button v-if="currentPath" @click="emit('refresh')" title="Refresh"
        class="p-1.5 rounded-lg text-slate-500 hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>

      <!-- View toggle -->
      <div class="flex items-center gap-0.5 bg-slate-800/60 rounded-lg p-0.5">
        <button @click="emit('update:viewMode', 'list')" title="List view"
          :class="['p-1.5 rounded-md transition-colors', viewMode === 'list' ? 'bg-slate-700 text-[var(--c-text-3)]' : 'text-slate-500 hover:text-[var(--c-text-2)]']">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
          </svg>
        </button>
        <button @click="emit('update:viewMode', 'grid')" title="Grid view"
          :class="['p-1.5 rounded-md transition-colors', viewMode === 'grid' ? 'bg-slate-700 text-[var(--c-text-3)]' : 'text-slate-500 hover:text-[var(--c-text-2)]']">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.sel-btn {
  @apply p-1.5 rounded-lg text-slate-500 hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors;
}
.sel-btn-danger {
  @apply hover:bg-red-900/30 hover:text-red-400;
}
</style>
