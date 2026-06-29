<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { useNotifications } from '../../lib/notifications'
import { useClipboard } from '../../lib/clipboard'
import { useUploads } from '../../lib/uploads'
import { useDesktop } from '../../lib/desktop'
import { downloadUrl } from '../../lib/file-url'
import { randomId } from '../../lib/uuid'
import { pollJob } from '../../lib/jobs'
import FilePermissionsDialog from '../FilePermissionsDialog.vue'
import PlacesSidebar from './PlacesSidebar.vue'
import FileToolbar from './FileToolbar.vue'
import FileListView from './FileListView.vue'
import FileGridView from './FileGridView.vue'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import FilePreviewModal from './preview/FilePreviewModal.vue'
import FilePropertiesModal from './FilePropertiesModal.vue'

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }
type Place = { id: string; name: string; path: string }
interface Crumb { label: string; path: string; clickable: boolean }

const props = defineProps<{ desktopWindow?: boolean }>()

const { isAdmin, token }    = useAuth()
const { track, trackBatch } = useNotifications()
const { clipboard, copy: clipCopy, cut: clipCut, clear: clipClear } = useClipboard()
const uploads = useUploads()
const { openFilePreview } = useDesktop()

const BASE_URL   = import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/trpc$/, '') : ''
const CHUNK_SIZE = 2 * 1024 * 1024

// ── state ────────────────────────────────────────────────────────────────────
const currentPath     = ref<string | null>(null)
const entries         = ref<Entry[]>([])
const dbPlaces        = ref<Place[]>([])
const viewMode        = ref<'list' | 'grid'>('list')
const loading         = ref(false)
const error           = ref('')
const selected        = ref<Set<string>>(new Set())
const selectionAnchor = ref<string | null>(null)
const renamingPath    = ref<string | null>(null)
const renameValue     = ref('')
const pendingPaths    = ref<string[]>([])
const creatingFolder  = ref(false)
const permDialogPath  = ref<string | null>(null)
const propertiesEntry = ref<Entry | null>(null)
const propertiesPlace = ref<Place | null>(null)
const activePlaceId   = ref<string | null>(null)
const dragOver        = ref(false)
let   dragDepth = 0
const fileInput = ref<HTMLInputElement | null>(null)
const ctxMenu     = ref<{ x: number; y: number } | null>(null)
const sidebarOpen = ref(false)
const previewEntry = ref<Entry | null>(null)

// ── sort ─────────────────────────────────────────────────────────────────────
type SortField = 'name' | 'size' | 'date'
const sortField = ref<SortField>('name')
const sortDir   = ref<'asc' | 'desc'>('asc')

const sortedEntries = computed(() => {
  const arr = [...entries.value]
  arr.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    let cmp = 0
    if (sortField.value === 'name') {
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    } else if (sortField.value === 'size') {
      cmp = (a.size ?? -1) - (b.size ?? -1)
    } else {
      cmp = new Date(a.mtime).getTime() - new Date(b.mtime).getTime()
    }
    return sortDir.value === 'asc' ? cmp : -cmp
  })
  return arr
})

function setSort(field: SortField) {
  if (sortField.value === field) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortField.value = field
    sortDir.value = 'asc'
  }
}

// ── filter (Cmd/Ctrl+K) ──────────────────────────────────────────────────────
const showFilter  = ref(false)
const filterQuery = ref('')
const filterInput = ref<HTMLInputElement | null>(null)

const displayEntries = computed(() => {
  const q = filterQuery.value.trim().toLowerCase()
  if (!q) return sortedEntries.value
  return sortedEntries.value.filter(e => e.name.toLowerCase().includes(q))
})

function openFilter() {
  showFilter.value = true
  nextTick(() => filterInput.value?.focus())
}

function closeFilter() {
  showFilter.value = false
  filterQuery.value = ''
}

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    const tag = (document.activeElement as HTMLElement | null)?.tagName?.toLowerCase()
    if (tag === 'textarea') return
    if (tag === 'input' && document.activeElement !== filterInput.value) return
    e.preventDefault()
    if (showFilter.value) filterInput.value?.focus()
    else openFilter()
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))

function openFile(entry: Entry) {
  if (props.desktopWindow) {
    openFilePreview({ path: entry.path, name: entry.name, size: entry.size })
  } else {
    previewEntry.value = entry
  }
}

// ── places ───────────────────────────────────────────────────────────────────
const VIRTUAL_ROOT: Place = { id: '__root__', name: 'Root', path: '/' }

const allPlaces = computed((): Place[] =>
  isAdmin.value ? [VIRTUAL_ROOT, ...dbPlaces.value] : dbPlaces.value
)

const activePlace = computed(() =>
  activePlaceId.value ? allPlaces.value.find(p => p.id === activePlaceId.value) ?? null : null
)

// ── breadcrumbs ──────────────────────────────────────────────────────────────
const breadcrumbs = computed((): Crumb[] => {
  if (!currentPath.value || !activePlace.value) return []
  const place = activePlace.value

  if (place.id === '__root__') {
    const segments = currentPath.value.split('/').filter(Boolean)
    const crumbs: Crumb[] = [{ label: '/', path: '/', clickable: segments.length > 0 }]
    let acc = ''
    for (let i = 0; i < segments.length; i++) {
      acc += '/' + segments[i]
      crumbs.push({ label: segments[i]!, path: acc, clickable: i < segments.length - 1 })
    }
    return crumbs
  }

  const relative = currentPath.value.slice(place.path.length).split('/').filter(Boolean)
  const crumbs: Crumb[] = [{ label: place.name, path: place.path, clickable: relative.length > 0 }]
  let acc = place.path
  for (let i = 0; i < relative.length; i++) {
    acc += '/' + relative[i]
    crumbs.push({ label: relative[i]!, path: acc, clickable: i < relative.length - 1 })
  }
  return crumbs
})

// ── navigation ───────────────────────────────────────────────────────────────
function selectPlace(place: Place) {
  activePlaceId.value = place.id
  selected.value = new Set()
  navigate(place.path)
}

const canGoUp = computed(() => {
  if (!currentPath.value || !activePlace.value) return false
  if (activePlace.value.id === '__root__') return currentPath.value !== '/'
  return currentPath.value !== activePlace.value.path
})

async function navigate(path: string) {
  loading.value = true
  error.value = ''
  selected.value = new Set()
  selectionAnchor.value = null
  try {
    entries.value = (await trpc.fs.list.query({ path })) as Entry[]
    currentPath.value = path
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to read directory'
  } finally {
    loading.value = false
  }
}

function goUp() {
  if (!currentPath.value || !activePlace.value) return
  const parent = currentPath.value.substring(0, currentPath.value.lastIndexOf('/')) || '/'
  if (!isAdmin.value && parent.length < activePlace.value.path.length) return
  navigate(parent)
}

function refresh() {
  if (currentPath.value) navigate(currentPath.value)
}

// ── selection ────────────────────────────────────────────────────────────────
function selectEntry(entry: Entry, e: MouseEvent) {
  e.stopPropagation()

  if (e.shiftKey && selectionAnchor.value !== null) {
    const paths = entries.value.map(en => en.path)
    const fromIdx = paths.indexOf(selectionAnchor.value)
    const toIdx   = paths.indexOf(entry.path)
    if (fromIdx !== -1) {
      const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
      const next = new Set(selected.value)
      for (let i = lo; i <= hi; i++) next.add(paths[i]!)
      selected.value = next
    }
  } else {
    const next = new Set(selected.value)
    if (next.has(entry.path)) next.delete(entry.path)
    else next.add(entry.path)
    selected.value = next
    selectionAnchor.value = entry.path
  }
}

function handleRowClick(entry: Entry, e: MouseEvent) {
  selectEntry(entry, e)
}

function handleRowDblClick(entry: Entry) {
  if (entry.type === 'dir') navigate(entry.path)
  else openFile(entry)
}

function handleGridCardClick(entry: Entry, e: MouseEvent) {
  selectEntry(entry, e)
}

function handleGridCardDblClick(entry: Entry) {
  if (entry.type === 'dir') navigate(entry.path)
  else openFile(entry)
}

function selectAll() {
  selected.value = new Set(entries.value.map(e => e.path))
  selectionAnchor.value = null
}

function clearSelection() {
  selected.value = new Set()
  selectionAnchor.value = null
}

const selectedEntries = computed(() =>
  entries.value.filter(e => selected.value.has(e.path))
)

// ── file operations ──────────────────────────────────────────────────────────
async function createFolder() {
  if (!currentPath.value) return
  creatingFolder.value = true
  try {
    await track('Creating folder', async () => {
      const { jobId } = await trpc.fs.mkdir.mutate({ parentPath: currentPath.value!, name: 'New Folder' })
      await pollJob(jobId)
    })
  } finally {
    creatingFolder.value = false
  }
  refresh()
}

function doCopy() {
  if (!selected.value.size) return
  clipCopy([...selected.value])
}

function doCut() {
  if (!selected.value.size) return
  clipCut([...selected.value])
}

async function doPaste() {
  if (!clipboard.value || !currentPath.value) return
  const { paths, mode } = clipboard.value
  const dst = currentPath.value
  if (mode === 'cut') pendingPaths.value = [...paths]
  try {
    await trackBatch(
      mode === 'copy' ? `Copying ${paths.length} item(s)` : `Moving ${paths.length} item(s)`,
      paths.map(src => async () => {
        const { jobId } = mode === 'copy'
          ? await trpc.fs.copy.mutate({ src, dstDir: dst })
          : await trpc.fs.move.mutate({ src, dstDir: dst })
        await pollJob(jobId)
      })
    )
  } finally {
    pendingPaths.value = []
  }
  clipClear()
  clearSelection()
  refresh()
}

async function doDelete() {
  if (!selected.value.size) return
  const paths = [...selected.value]
  pendingPaths.value = [...paths]
  try {
    await trackBatch(
      `Deleting ${paths.length} item(s)`,
      paths.map(p => async () => {
        const { jobId } = await trpc.fs.delete.mutate({ path: p })
        await pollJob(jobId)
      })
    )
  } finally {
    pendingPaths.value = []
  }
  clearSelection()
  refresh()
}

async function downloadSelected() {
  const entry = selectedEntries.value[0]
  if (!entry || entry.type !== 'file') return
  const url = await downloadUrl(entry.path)
  const a = document.createElement('a')
  a.href = url
  a.download = entry.name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function openPermissions() {
  if (selected.value.size !== 1) return
  permDialogPath.value = [...selected.value][0]!
}

function openProperties() {
  if (selected.value.size !== 1) return
  propertiesEntry.value = selectedEntries.value[0] ?? null
}

// ── archive ──────────────────────────────────────────────────────────────────
async function doZip() {
  if (!currentPath.value || selected.value.size === 0) return
  const paths = [...selected.value]

  let name: string
  if (paths.length === 1) {
    const base = paths[0]!.split('/').pop() ?? 'archive'
    name = base + '.zip'
  } else {
    const folder = currentPath.value.split('/').filter(Boolean).pop() ?? 'archive'
    name = folder + '.zip'
  }

  await track(`Compressing ${paths.length} item(s)`, async () => {
    const { jobId } = await trpc.fs.zip.mutate({ paths, destDir: currentPath.value!, name })
    await pollJob(jobId)
  })
  refresh()
}

async function doUnzip() {
  if (!currentPath.value || selected.value.size !== 1) return
  const archivePath = [...selected.value][0]!
  const base = archivePath.split('/').pop() ?? 'archive'
  const destName = base.replace(/\.zip$/i, '')
  const destDir = currentPath.value + '/' + destName

  await track(`Extracting ${base}`, async () => {
    const { jobId } = await trpc.fs.unzip.mutate({ path: archivePath, destDir })
    await pollJob(jobId)
  })
  refresh()
}

// ── rename ───────────────────────────────────────────────────────────────────
function startRename(entry: Entry) {
  renamingPath.value = entry.path
  renameValue.value  = entry.name
}

async function commitRename() {
  if (!renamingPath.value || !renameValue.value.trim()) { cancelRename(); return }
  const path = renamingPath.value
  const name = renameValue.value.trim()
  renamingPath.value = null
  pendingPaths.value = [path]
  try {
    await track(`Renaming to "${name}"`, async () => {
      const { jobId } = await trpc.fs.rename.mutate({ path, newName: name })
      await pollJob(jobId)
    })
  } finally {
    pendingPaths.value = []
  }
  refresh()
}

function cancelRename() {
  renamingPath.value = null
  renameValue.value  = ''
}

// ── upload ───────────────────────────────────────────────────────────────────
async function uploadFiles(files: FileList | File[]) {
  if (!currentPath.value) return
  const dest = currentPath.value

  for (const file of Array.from(files)) {
    const id = randomId()

    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))
    const ac = new AbortController()

    uploads.register({ id, name: file.name, destDir: dest, totalChunks, sentChunks: 0, totalBytes: file.size, sentBytes: 0, bytesPerSec: 0, status: 'uploading' })
    uploads.setAbortController(id, ac)

    try {
      for (let i = 0; i < totalChunks; i++) {
        while (uploads.isPaused(id)) await new Promise(r => setTimeout(r, 200))
        if (ac.signal.aborted) throw new DOMException('Cancelled', 'AbortError')

        const resp = await fetch(`${BASE_URL}/files/upload/chunk`, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'Authorization':  `Bearer ${token.value}`,
            'Content-Type':   'application/octet-stream',
            'X-Upload-Id':    id,
            'X-Chunk-Index':  String(i),
            'X-Total-Chunks': String(totalChunks),
            'X-File-Name':    encodeURIComponent(file.name),
            'X-Dest-Dir':     encodeURIComponent(dest),
          },
          body: file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        })
        if (!resp.ok) throw new Error(await resp.text())
        const body = await resp.json() as { ok: true; done: boolean; jobId?: string }
        uploads.updateProgress(id, i + 1, Math.min(CHUNK_SIZE, file.size - i * CHUNK_SIZE))

        // The last chunk's response carries the fs.assemble jobId — wait for
        // it to actually finish writing the destination file before treating
        // the upload as done, same reason as the other fs mutations below.
        if (body.done && body.jobId) await pollJob(body.jobId)
      }

      uploads.setStatus(id, 'done')
      if (currentPath.value === dest) refresh()
      setTimeout(() => uploads.remove(id), 3000)
    } catch (e: any) {
      const isAbort = e instanceof DOMException && e.name === 'AbortError'
      if (isAbort) {
        uploads.setStatus(id, 'cancelled')
        fetch(`${BASE_URL}/files/upload/cancel`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token.value}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: id }),
        }).catch(() => {})
        setTimeout(() => uploads.remove(id), 2500)
      } else {
        uploads.setStatus(id, 'error', e.message)
      }
    } finally {
      uploads.cleanup(id)
    }
  }
}

function handleFileInput(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (files?.length) uploadFiles(files)
  ;(e.target as HTMLInputElement).value = ''
}

function handleDragEnter() { dragDepth++; dragOver.value = true }
function handleDragLeave() { if (--dragDepth === 0) dragOver.value = false }
function handleDrop(e: DragEvent) {
  dragDepth = 0; dragOver.value = false
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files)
}

// ── context menu ─────────────────────────────────────────────────────────────
function openContextMenu(entry: Entry | null, e: MouseEvent) {
  if (entry && !selected.value.has(entry.path)) {
    selected.value = new Set([entry.path])
    selectionAnchor.value = entry.path
  }
  const x = Math.min(e.clientX, window.innerWidth  - 200)
  const y = Math.min(e.clientY, window.innerHeight - 320)
  ctxMenu.value = { x, y }
}

function closeContextMenu() { ctxMenu.value = null }

// ── init ─────────────────────────────────────────────────────────────────────
onMounted(async () => {
  dbPlaces.value = (await trpc.place.list.query()) as Place[]
})
</script>

<template>
  <div class="flex h-full relative overflow-hidden" @click="clearSelection">

    <!-- Mobile sidebar overlay -->
    <div
      v-if="sidebarOpen"
      class="absolute inset-0 z-10 bg-black/40 sm:hidden"
      @click.stop="sidebarOpen = false"
    />

    <PlacesSidebar
      :class="[
        'transition-transform duration-200',
        'absolute sm:relative z-20 sm:z-0 inset-y-0 left-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0',
      ]"
      :places="allPlaces"
      :active-place-id="activePlaceId"
      @select="selectPlace($event); sidebarOpen = false"
      @open-properties="propertiesPlace = $event"
    />

    <div class="flex-1 flex flex-col min-w-0">

      <FileToolbar
        :current-path="currentPath"
        :breadcrumbs="breadcrumbs"
        :can-go-up="canGoUp"
        :selected-count="selected.size"
        :selected-entries="selectedEntries"
        :clipboard="clipboard"
        :view-mode="viewMode"
        :sidebar-open="sidebarOpen"
        @go-up="goUp"
        @navigate="navigate"
        @clear-selection="clearSelection"
        @copy="doCopy"
        @cut="doCut"
        @start-rename="startRename"
        @download="downloadSelected"
        @open-permissions="openPermissions"
        @delete="doDelete"
        @create-folder="createFolder"
        @upload-click="fileInput?.click()"
        @paste="doPaste"
        @refresh="refresh"
        @update:view-mode="viewMode = $event"
        @toggle-sidebar="sidebarOpen = !sidebarOpen"
      />

      <!-- Content area -->
      <div
        class="flex-1 overflow-auto relative"
        @dragenter="handleDragEnter"
        @dragleave="handleDragLeave"
        @dragover.prevent
        @drop.prevent="handleDrop"
        @contextmenu.prevent="openContextMenu(null, $event)"
      >
        <!-- Drag overlay -->
        <div v-if="dragOver && currentPath"
          class="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-[var(--c-accent-subtle)] border-2 border-dashed border-[var(--c-accent)] rounded pointer-events-none select-none">
          <svg class="w-10 h-10 text-[var(--c-accent)] opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
          </svg>
          <span class="text-sm text-[var(--c-accent)] font-medium">Drop to upload</span>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="flex items-center text-[var(--c-text-3)] text-sm p-6">
          <LoadingSpinner />
        </div>

        <!-- Error -->
        <div v-else-if="error" class="flex items-center gap-2 text-[var(--c-accent)] text-sm p-6">
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          </svg>
          {{ error }}
        </div>

        <!-- No place selected -->
        <div v-else-if="!currentPath" class="flex items-center justify-center h-full text-[var(--c-text-3)] select-none">
          <div class="text-center space-y-2">
            <svg class="w-10 h-10 mx-auto opacity-20" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
            </svg>
            <p class="text-sm">Select a place</p>
          </div>
        </div>

        <!-- Empty directory -->
        <div v-else-if="entries.length === 0" class="flex items-center justify-center h-full text-[var(--c-text-3)] select-none">
          <p class="text-sm">Empty directory</p>
        </div>

        <!-- Has entries: filter bar (optional) + view -->
        <template v-else>
          <!-- Filter bar (Cmd/Ctrl+K) -->
          <div v-if="showFilter" class="sticky top-0 z-20 px-3 py-2 bg-[var(--c-bg)] border-b border-[var(--c-border)] flex items-center gap-2">
            <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/>
            </svg>
            <input
              ref="filterInput"
              v-model="filterQuery"
              placeholder="Filter by name…"
              @keydown.escape="closeFilter"
              class="flex-1 bg-transparent text-sm text-[var(--c-text-1)] placeholder:text-[var(--c-text-3)] outline-none"
            />
            <span v-if="filterQuery" class="text-[10px] text-[var(--c-text-3)]">{{ displayEntries.length }} of {{ sortedEntries.length }}</span>
            <button @click="closeFilter" class="text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors p-0.5">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

          <!-- Grid view -->
          <FileGridView
            v-if="viewMode === 'grid'"
            :entries="displayEntries"
            :selected="selected"
            :renaming-path="renamingPath"
            :rename-value="renameValue"
            :pending-paths="pendingPaths"
            :creating-folder="creatingFolder"
            @card-click="handleGridCardClick"
            @card-dbl-click="handleGridCardDblClick"
            @select-entry="selectEntry"
            @contextmenu="openContextMenu"
            @start-rename="startRename"
            @commit-rename="commitRename"
            @cancel-rename="cancelRename"
            @update:rename-value="renameValue = $event"
            @open-file="openFile"
          />

          <!-- List view -->
          <FileListView
            v-else
            :entries="displayEntries"
            :sort-field="sortField"
            :sort-dir="sortDir"
            @set-sort="setSort"
            :selected="selected"
            :renaming-path="renamingPath"
            :rename-value="renameValue"
            :pending-paths="pendingPaths"
            :creating-folder="creatingFolder"
            @row-click="handleRowClick"
            @row-dbl-click="handleRowDblClick"
            @select-entry="selectEntry"
            @contextmenu="openContextMenu"
            @start-rename="startRename"
            @commit-rename="commitRename"
            @cancel-rename="cancelRename"
            @update:rename-value="renameValue = $event"
            @select-all="selectAll"
            @clear-selection="clearSelection"
            @open-file="openFile"
          />
        </template>
      </div>
    </div>
  </div>

  <input ref="fileInput" type="file" multiple class="hidden" @change="handleFileInput" />

  <!-- Context menu -->
  <Teleport to="body">
    <template v-if="ctxMenu">
      <div class="fixed inset-0 z-40" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu" />
      <div
        @click.stop
        class="fixed z-50 bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl overflow-hidden py-1.5 min-w-[180px]"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      >
        <!-- Selection-dependent actions -->
        <template v-if="selected.size > 0">
          <button @click="doCopy(); closeContextMenu()"
            class="ctx-item">
            <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
            </svg>
            Copy
          </button>
          <button @click="doCut(); closeContextMenu()"
            class="ctx-item">
            <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"/>
            </svg>
            Cut
          </button>
          <template v-if="selected.size === 1">
            <button v-if="selectedEntries[0]?.type === 'file'" @click="openFile(selectedEntries[0]!); closeContextMenu()"
              class="ctx-item">
              <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
              </svg>
              Open
            </button>
            <button @click="startRename(selectedEntries[0]!); closeContextMenu()"
              class="ctx-item">
              <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
              </svg>
              Rename
            </button>
            <button v-if="selectedEntries[0]?.type === 'file'" @click="downloadSelected(); closeContextMenu()"
              class="ctx-item">
              <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              Download
            </button>
            <button @click="openPermissions(); closeContextMenu()"
              class="ctx-item">
              <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
              </svg>
              Permissions
            </button>
            <button @click="openProperties(); closeContextMenu()"
              class="ctx-item">
              <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              Properties
            </button>
          </template>
          <!-- Compress to ZIP — any selection -->
          <button @click="doZip(); closeContextMenu()" class="ctx-item">
            <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/>
            </svg>
            Compress to ZIP
          </button>

          <!-- Extract Here — only for a single .zip file -->
          <button
            v-if="selected.size === 1 && selectedEntries[0]?.type === 'file' && selectedEntries[0]?.name.toLowerCase().endsWith('.zip')"
            @click="doUnzip(); closeContextMenu()"
            class="ctx-item"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M7 10l5 5m0 0l5-5m-5 5V4"/>
            </svg>
            Extract Here
          </button>

          <div class="h-px bg-[var(--c-border-strong)] mx-2 my-1" />
          <button @click="doDelete(); closeContextMenu()"
            class="ctx-item ctx-item-danger">
            <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
            Delete
          </button>
          <div class="h-px bg-[var(--c-border-strong)] mx-2 my-1" />
        </template>

        <!-- General actions -->
        <button v-if="currentPath" @click="createFolder(); closeContextMenu()" class="ctx-item">
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
          </svg>
          New Folder
        </button>
        <button v-if="currentPath" @click="fileInput?.click(); closeContextMenu()" class="ctx-item">
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
          </svg>
          Upload
        </button>
        <button v-if="clipboard && currentPath" @click="doPaste(); closeContextMenu()"
          :class="['ctx-item', clipboard.mode === 'cut' ? 'text-[var(--c-warning)]' : 'text-[var(--c-accent)]']">
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
          Paste {{ clipboard.mode === 'cut' ? '(move)' : '' }}
        </button>
        <div v-if="currentPath" class="h-px bg-[var(--c-border-strong)] mx-2 my-1" />
        <button v-if="currentPath" @click="refresh(); closeContextMenu()" class="ctx-item">
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          Refresh
        </button>
      </div>
    </template>
  </Teleport>

  <FilePermissionsDialog
    v-if="permDialogPath"
    :path="permDialogPath"
    @close="permDialogPath = null"
  />

  <FilePreviewModal
    v-if="previewEntry"
    :entry="previewEntry"
    @close="previewEntry = null"
  />

  <FilePropertiesModal
    v-if="propertiesEntry"
    :entry="propertiesEntry"
    @close="propertiesEntry = null"
    @open-permissions="propertiesEntry = null; openPermissions()"
  />

  <FilePropertiesModal
    v-if="propertiesPlace"
    :place="propertiesPlace"
    @close="propertiesPlace = null"
  />
</template>

<style scoped>
@reference "tailwindcss";

.ctx-item {
  @apply w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-[var(--c-text-2)]
         hover:bg-[var(--c-hover)] transition-colors text-left;
}
.ctx-item-danger {
  color: var(--c-accent);
}
.ctx-item-danger:hover {
  background-color: var(--c-accent-subtle);
}
</style>
