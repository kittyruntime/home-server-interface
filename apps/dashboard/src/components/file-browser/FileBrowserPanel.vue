<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import FileTypeIcon from './FileTypeIcon.vue'
import FolderGlyph from './FolderGlyph.vue'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Item } from '@/components/ui/item'
import { LOADING } from '../../lib/loading'
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { useNotifications } from '../../lib/notifications'
import { useClipboard } from '../../lib/clipboard'
import { copyText } from '../../lib/copy-text'
import { useToast } from '../../lib/toast'
import { useUploads, runTransferBatch } from '../../lib/uploads'
import { useDesktop } from '../../lib/desktop'
import { pendingFolder, takeFolderFocus } from '../../lib/app-focus'
import { downloadUrl } from '../../lib/file-url'
import { awaitJob } from '../../lib/jobs'
import { useConfirm } from '../../lib/confirm'
import { useDeleteConfirm } from '../../lib/delete-confirm'
import { startUpload, hydrateInterruptedUploads } from '../../lib/upload-runner'
import FilePermissionsDialog from '../FilePermissionsDialog.vue'
import ShareLinkModal from '../share/ShareLinkModal.vue'
import PlacesSidebar from './PlacesSidebar.vue'
import SharedLinksSection from '../SharedLinksSection.vue'
import FileToolbar from './FileToolbar.vue'
import FileListView from './FileListView.vue'
import FileGridView from './FileGridView.vue'
import FilePreviewModal from './preview/FilePreviewModal.vue'
import FilePropertiesModal from './FilePropertiesModal.vue'
import DisplaySettings from './DisplaySettings.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useFilePrefs } from '../../lib/file-prefs'
import { askConflict, planTransfer } from '../../lib/conflicts'
import { affectedDirs, announceFolderChanges, folderChanges } from '../../lib/folder-changes'
import { canDropInto, dropAction, endFileDrag, fileDrag, isInternalDrag, startFileDrag, type DropAction } from '../../lib/file-drag'
import { isBookmarked, moveBookmark, placeFor, renameBookmark, toggleBookmark, type Bookmark } from '../../lib/bookmarks'
import RenameBookmarkModal from './RenameBookmarkModal.vue'
import TrashView from './TrashView.vue'
import FolderStatusBar from './FolderStatusBar.vue'
import { headerSort, sortEntries, visibleEntries, type SortField } from '../../lib/file-sort'
import { isTouchClick } from '../../lib/touch'
import { ArchiveIcon, BookmarkIcon, ClipboardCopyIcon, ClipboardPasteIcon, CopyIcon, DownloadIcon, EyeIcon, FilePlusIcon, FolderPlusIcon, InfoIcon, KeyRoundIcon, MenuIcon, PackageOpenIcon, PencilIcon, FolderInputIcon, RefreshCwIcon, ScissorsIcon, SearchIcon, Share2Icon, Trash2Icon, TriangleAlertIcon, UploadIcon, XIcon } from '@lucide/vue'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu'

const { t } = useI18n()

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }
type Place = { id: string; name: string; path: string; icon?: string | null; trashEnabled?: boolean }
interface Crumb { label: string; path: string; clickable: boolean }

const props = defineProps<{ desktopWindow?: boolean }>()

const { isAdmin }    = useAuth()
const { track, trackBatch } = useNotifications()
const { confirm } = useConfirm()
const { confirmFileDelete, setConfirmFileDelete } = useDeleteConfirm()
const { clipboard, copy: clipCopy, cut: clipCut, clear: clipClear } = useClipboard()
const uploads = useUploads()
const { openFilePreview } = useDesktop()

// ── state ────────────────────────────────────────────────────────────────────
const currentPath     = ref<string | null>(null)
const entries         = ref<Entry[]>([])
const dbPlaces        = ref<Place[]>([])
const loading         = ref(false)
const error           = ref('')
const selected        = ref<Set<string>>(new Set())
const selectionAnchor = ref<string | null>(null)
const renamingPath    = ref<string | null>(null)
const renameValue     = ref('')
const pendingPaths    = ref<string[]>([])
const creatingFolder  = ref(false)
const creatingFile    = ref(false)
const permDialogPath  = ref<string | null>(null)
const shareTarget     = ref<{ path: string; name: string } | null>(null)
const propertiesEntry = ref<Entry | null>(null)
const propertiesPlace = ref<Place | null>(null)
const activePlaceId   = ref<string | null>(null)
const dragOver        = ref(false)
let   dragDepth = 0
const fileInput = ref<HTMLInputElement | null>(null)
const sidebarOpen = ref(false)
// The file manager's settings (shared links, display) replace the files while open.
const settingsTab = ref<'display' | 'shared' | null>(null)
// The trash (#200) replaces the files too.
const trashOpen = ref(false)
const showShared = computed(() => settingsTab.value !== null || trashOpen.value)
const previewEntry = ref<Entry | null>(null)

// ── search ────────────────────────────────────────────────────────────────────
type SearchResult = { path: string; name: string; isDir: boolean; size: number; relativePath: string }
const searchQuery   = ref('')
const searchResults = ref<SearchResult[]>([])
const searchLoading = ref(false)
const isSearchMode  = computed(() => searchQuery.value.trim().length > 0)

async function handleSearch(query: string) {
  searchQuery.value = query
  if (!query || !activePlaceId.value) {
    searchResults.value = []
    return
  }
  searchLoading.value = true
  try {
    searchResults.value = await trpc.fs.search.query({ placeId: activePlaceId.value, query })
  } catch (e: unknown) {
    console.error('Search failed', e)
    searchResults.value = []
  } finally {
    searchLoading.value = false
  }
}

function navigateToSearchResult(r: SearchResult) {
  let targetPath: string
  if (r.isDir) {
    targetPath = r.path
  } else {
    const lastSlash = r.path.lastIndexOf('/')
    targetPath = lastSlash > 0 ? r.path.slice(0, lastSlash) : (activePlace.value?.path ?? '/')
  }
  searchQuery.value = ''
  searchResults.value = []
  navigate(targetPath)
}

// Clear search when the active place changes
watch(activePlaceId, () => {
  searchQuery.value = ''
  searchResults.value = []
})

// ── sort and hidden files (#196): per-account display preferences ───────────
const { filePrefs, setFilePrefs, setSort } = useFilePrefs()
const viewMode = computed(() => filePrefs.value.view)
const sortField = computed(() => filePrefs.value.sortField)
const sortDir = computed(() => filePrefs.value.sortDir)

const activeUploads = computed(() =>
  uploads.tasks.value.filter(
    t => t.destDir === currentPath.value && t.status !== 'done' && t.status !== 'cancelled'
  )
)

const sortedEntries = computed(() =>
  sortEntries(visibleEntries(entries.value, filePrefs.value.showHidden), { field: sortField.value, dir: sortDir.value }),
)

function onHeaderSort(field: SortField) {
  setSort(headerSort({ field: sortField.value, dir: sortDir.value }, field))
}

// ── filter (Cmd/Ctrl+K) ──────────────────────────────────────────────────────
const showFilter  = ref(false)
const filterQuery = ref('')
const filterInput = ref<InstanceType<typeof Input> | null>(null)

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

// Desktop file manager shortcuts, only on the listing: never while typing,
// renaming, in a dialog or with the settings open.
function fileShortcut(e: KeyboardEvent): boolean {
  if (showShared.value || renamingPath.value || !currentPath.value || document.querySelector('dialog[open]')) return false
  const el = document.activeElement as HTMLElement | null
  const tag = el?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return false
  // Inside an open menu, keys belong to the menu.
  if (el?.closest('[role=menu], [role=listbox]')) return false
  const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
  const one = selectedEntries.value.length === 1 ? selectedEntries.value[0]! : null
  const key = e.key.toLowerCase()
  let handled = true
  if (plain && e.key === 'Delete' && selected.value.size) void doDelete()
  else if (plain && e.key === 'F2' && one) startRename(one)
  else if (plain && e.key === 'Enter' && one && !el?.closest('button, a')) openEntry(one)
  else if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'Enter' && one) openProperties()
  else if (ctrl && key === 'x' && selected.value.size && !window.getSelection()?.toString()) doCut()
  else if (ctrl && key === 'c' && selected.value.size && !window.getSelection()?.toString()) doCopy()
  else if (ctrl && key === 'v' && clipboard.value) void doPaste()
  else if (ctrl && key === 'a' && displayEntries.value.length) selectAll()
  else handled = false
  if (handled) e.preventDefault()
  return handled
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (fileShortcut(e)) return
  // Ctrl+H shows or hides dotfiles, as in desktop file managers.
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'h' && !showShared.value) {
    const tag = (document.activeElement as HTMLElement | null)?.tagName?.toLowerCase()
    if (tag !== 'input' && tag !== 'textarea') {
      e.preventDefault()
      setFilePrefs({ showHidden: !filePrefs.value.showHidden })
      return
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    if (showShared.value) return
    const tag = (document.activeElement as HTMLElement | null)?.tagName?.toLowerCase()
    if (tag === 'textarea') return
    if (tag === 'input' && document.activeElement !== filterInput.value?.el) return
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

// ── bookmarks (#199) ─────────────────────────────────────────────────────────
const bookmarks = computed(() => filePrefs.value.bookmarks)
const missingBookmarks = ref(new Set<string>())
const renamingBookmark = ref<Bookmark | null>(null)
const currentBookmarked = computed(() => !!currentPath.value && isBookmarked(bookmarks.value, currentPath.value))

function setBookmarks(next: Bookmark[]) { setFilePrefs({ bookmarks: next }) }
function toggleBookmarkAt(path: string) { setBookmarks(toggleBookmark(bookmarks.value, path)) }

// A bookmark whose folder is gone or out of reach shows dimmed; checked when
// the list changes, never blocking the panel.
async function checkBookmarks() {
  const results = await Promise.allSettled(bookmarks.value.map(b => trpc.fs.stat.query({ path: b.path })))
  const missing = new Set<string>()
  results.forEach((r, i) => {
    if (r.status === 'rejected' || r.value.type !== 'dir') missing.add(bookmarks.value[i]!.path)
  })
  missingBookmarks.value = missing
}
watch(() => bookmarks.value.map(b => b.path).join('\n'), () => { void checkBookmarks() }, { immediate: true })

async function openBookmark(path: string) {
  const place = placeFor(allPlaces.value, path)
  settingsTab.value = null
  trashOpen.value = false
  sidebarOpen.value = false
  if (place) activePlaceId.value = place.id
  await navigate(path)
  if (error.value) missingBookmarks.value = new Set([...missingBookmarks.value, path])
}

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
const hasTrash = computed(() => dbPlaces.value.some(p => p.trashEnabled))
/** Every selected item goes to a trash when deleted. */
const selectionToTrash = computed(() => selectedEntries.value.length > 0 && selectedEntries.value.every(e => trashPlaceFor(e.path)))

function openTrash() {
  handleSearch('')
  closeFilter()
  settingsTab.value = null
  trashOpen.value = true
  sidebarOpen.value = false
}

/** The place a path's deletion goes to the trash of, or null when it is removed for good. */
function trashPlaceFor(path: string): Place | null {
  const place = placeFor(dbPlaces.value, path)
  return place?.trashEnabled && place.path !== path ? place : null
}

function openSettings(tab: 'display' | 'shared' = 'display') {
  handleSearch('')
  closeFilter()
  trashOpen.value = false
  settingsTab.value = tab
  sidebarOpen.value = false
}

function selectPlace(place: Place) {
  if (showShared.value && place.id === activePlaceId.value) {
    settingsTab.value = null
    trashOpen.value = false
    return
  }
  settingsTab.value = null
  trashOpen.value = false
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
    error.value = e?.message ?? t('uis.files.FileBrowserPanel.failedToReadDirectory')
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

// A plain click selects only that item, as in a desktop file manager, so a
// shortcut right after acts on what was clicked; Ctrl or Cmd adds or removes
// it, Shift selects a range. The checkboxes keep toggling.
function clickSelect(entry: Entry, e: MouseEvent) {
  if (e.shiftKey || e.ctrlKey || e.metaKey) return selectEntry(entry, e)
  e.stopPropagation()
  selected.value = new Set([entry.path])
  selectionAnchor.value = entry.path
}

// On a touch screen a tap opens, as in a phone's file manager: a double tap
// zooms instead of reaching dblclick. Once something is selected (checkbox or
// long press), taps add to or remove from the selection until it is cleared.
function tapOrClick(entry: Entry, e: MouseEvent) {
  if (!isTouchClick(e)) return clickSelect(entry, e)
  e.stopPropagation()
  if (selected.value.size > 0) return selectEntry(entry, e)
  openEntry(entry)
}

function handleRowClick(entry: Entry, e: MouseEvent) {
  tapOrClick(entry, e)
}

function handleRowDblClick(entry: Entry) {
  if (entry.type === 'dir') navigate(entry.path)
  else openFile(entry)
}

/** Opens a folder or previews a file: Enter, and the first item of the context menu. */
const openEntry = handleRowDblClick

function handleGridCardClick(entry: Entry, e: MouseEvent) {
  tapOrClick(entry, e)
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
// Worker fs ops resolve asynchronously: awaitJob waits for the terminal state
// and throws on failure so the tracking notification surfaces the real error.
async function createFolder() {
  if (!currentPath.value) return
  creatingFolder.value = true
  try {
    await track('Creating folder', async () => {
      const { jobId } = await trpc.fs.mkdir.mutate({ parentPath: currentPath.value!, name: 'New Folder' })
      await awaitJob(jobId)
    })
  } finally {
    creatingFolder.value = false
  }
  refresh()
}

async function createFile() {
  if (!currentPath.value) return
  creatingFile.value = true
  try {
    await track('Creating file', async () => {
      const { jobId } = await trpc.fs.touch.mutate({ parentPath: currentPath.value!, name: 'New File' })
      await awaitJob(jobId)
    })
  } finally {
    creatingFile.value = false
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
  await transfer(mode === 'copy' ? 'copy' : 'move', [...paths], currentPath.value)
  clipClear()
}

// Dragging items onto a folder, a place, a bookmark or a crumb moves them there.
function onEntryDragStart(entry: Entry, e: DragEvent) {
  if (!selected.value.has(entry.path)) {
    selected.value = new Set([entry.path])
    selectionAnchor.value = entry.path
  }
  const items = entries.value.filter(en => selected.value.has(en.path))
  startFileDrag(e, items.map(en => en.path), items.filter(en => en.type === 'dir').map(en => en.path))
}

function moveInto(dst: string, paths: string[], action: DropAction = 'move') {
  void transfer(action, paths, dst)
}

// The names already in dst: the open folder's list, or a quick listing.
async function namesIn(dst: string): Promise<Set<string>> {
  if (dst === currentPath.value) return new Set(entries.value.map(e => e.name))
  try {
    return new Set(((await trpc.fs.list.query({ path: dst })) as Entry[]).map(e => e.name))
  } catch {
    return new Set() // unreadable here: the NAS numbers a taken name anyway
  }
}

async function transfer(kind: 'copy' | 'move', paths: string[], dst: string) {
  const mode = kind === 'copy' ? 'copy' : 'cut'
  // A taken name asks: replace, keep both or skip (or cancel everything).
  const existing = await namesIn(dst)
  const plan = await planTransfer(paths, dst, existing, (src, remaining) => askConflict({
    name: src.split('/').pop() || src,
    dir: dst,
    isDir: entries.value.find(e => e.path === src)?.type === 'dir',
    remaining,
  }))
  if (!plan || plan.length === 0) return
  if (mode === 'cut') pendingPaths.value = plan.map(p => p.src)
  try {
    await runTransferBatch(
      mode === 'copy' ? 'copy' : 'move',
      plan.map(({ src, onConflict }) => async () => {
        const { jobId } = mode === 'copy'
          ? await trpc.fs.copy.mutate({ src, dstDir: dst, onConflict })
          : await trpc.fs.move.mutate({ src, dstDir: dst, onConflict })
        await awaitJob(jobId)
      })
    )
  } finally {
    pendingPaths.value = []
  }
  const done = plan.map(p => p.src)
  clearSelection()
  // Every window showing a changed folder refreshes, this one included; this
  // one also when the items went into a subfolder of what it shows.
  const dirs = affectedDirs(mode === 'copy' ? 'copy' : 'move', done, dst)
  announceFolderChanges(dirs)
  if (!currentPath.value || !dirs.includes(currentPath.value)) refresh()
}

// Another window moved or copied items into or out of the folder shown here.
watch(folderChanges, change => {
  if (currentPath.value && change.dirs.includes(currentPath.value)) refresh()
})

// Deleting in a place with a trash (#200) moves items there, with an Undo,
// and only the Trash removes them for good; elsewhere deleting is permanent:
// ask first, unless the user turned it off.
function deleteMessage(paths: string[]): string {
  if (paths.length > 1) return t('fileDelete.messageMany', { count: paths.length })
  const name = paths[0]!.split('/').pop() ?? paths[0]!
  const isDir = entries.value.find(e => e.path === paths[0])?.type === 'dir'
  return t(isDir ? 'fileDelete.messageFolder' : 'fileDelete.messageFile', { name })
}

type Trashed = { placeId: string; entry: { id: string; name: string } }

async function doDelete() {
  if (!selected.value.size) return
  const paths = [...selected.value]
  // Each item goes to its place's trash when it has one; only the others are
  // deleted for good, and only those are asked about.
  const permanent = paths.filter(p => !trashPlaceFor(p))
  const toTrash = permanent.length === 0
  if (permanent.length && confirmFileDelete.value) {
    const ok = await confirm(deleteMessage(permanent), {
      title: t('fileDelete.title'),
      confirmLabel: t('fileDelete.confirm'),
      danger: true,
      optOutLabel: t('fileDelete.dontAskAgain'),
      onOptOut: () => setConfirmFileDelete(false),
    })
    if (!ok) return
  }
  pendingPaths.value = [...paths]
  const trashed: Trashed[] = []
  try {
    await trackBatch(
      t(toTrash ? 'files.trash.moving' : 'fileDelete.deleting', { count: paths.length }),
      paths.map(p => async () => {
        const r = await trpc.fs.delete.mutate({ path: p })
        if (r.trashed) trashed.push(r.trashed)
        if (r.jobId) await awaitJob(r.jobId)
      })
    )
  } finally {
    pendingPaths.value = []
  }
  clearSelection()
  refresh()
  if (trashed.length) {
    toast.success(t('files.trash.moved', { count: trashed.length }), {
      label: t('files.trash.undo'),
      run: () => { void undoTrash(trashed) },
    })
  }
}

async function undoTrash(items: Trashed[]) {
  for (const it of items) {
    try { await trpc.trash.restore.mutate({ placeId: it.placeId, id: it.entry.id }) }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  }
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

function openShare() {
  const e = selectedEntries.value[0]
  if (e) shareTarget.value = { path: e.path, name: e.name }
}

const toast = useToast()

async function copySelectedPath() {
  const path = selectedEntries.value[0]?.path
  if (!path) return
  if (await copyText(path)) toast.success(t('files.copyPath.copied'))
  else toast.error(t('files.copyPath.failed'))
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
    await awaitJob(jobId)
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
    await awaitJob(jobId)
  })
  refresh()
}

// ── rename ───────────────────────────────────────────────────────────────────
function startRename(entry: Entry) {
  renamingPath.value = entry.path
  renameValue.value  = entry.name
  // autofocus does nothing on a field added after load: focus the visible one
  // (the phone list and the table both render), still within the tap, so a
  // phone opens its keyboard.
  void nextTick(() => {
    const field = [...document.querySelectorAll<HTMLInputElement>('input[data-rename]')].find(el => el.offsetParent !== null)
    field?.focus()
  })
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
      await awaitJob(jobId)
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
function uploadFiles(files: FileList | File[]) {
  if (!currentPath.value) return
  const dest = currentPath.value

  for (const file of Array.from(files)) {
    startUpload(file, dest, {
      onDone: () => { if (currentPath.value === dest) refresh() },
    })
  }
}

function handleFileInput(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (files?.length) uploadFiles(files)
  ;(e.target as HTMLInputElement).value = ''
}

// Files from the computer upload. Items dragged in the file manager move (or
// copy, Ctrl/Alt held) where they are dropped: onto a folder, or onto the list
// of another window, into the folder that window has open.
const dragKind = ref<'upload' | DropAction | null>(null)
const acceptsInternal = () => !!currentPath.value && !isSearchMode.value && canDropInto(fileDrag.value, currentPath.value)
function handleDragEnter(e: DragEvent) {
  if (isInternalDrag(e) && !acceptsInternal()) return
  dragDepth++
  dragOver.value = true
}
function handleDragOver(e: DragEvent) {
  if (isInternalDrag(e)) {
    if (!acceptsInternal()) return
    e.preventDefault()
    const action = dropAction(e)
    if (e.dataTransfer) e.dataTransfer.dropEffect = action
    dragKind.value = action
    return
  }
  e.preventDefault()
  dragKind.value = 'upload'
}
function handleDragLeave(e: DragEvent) {
  if (isInternalDrag(e) && !acceptsInternal()) return
  if (--dragDepth <= 0) { dragDepth = 0; dragOver.value = false; dragKind.value = null }
}
function handleDrop(e: DragEvent) {
  dragDepth = 0; dragOver.value = false; dragKind.value = null
  if (isInternalDrag(e)) {
    const drag = fileDrag.value
    const into = acceptsInternal() ? currentPath.value : null
    endFileDrag()
    if (drag && into) moveInto(into, drag.paths, dropAction(e))
    return
  }
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files)
}
// A folder row that takes the drop stops the event before it reaches the
// list: the capture phase clears the hint, the list sets it back only when the
// drop would land in the open folder.
function clearDragHint() { dragKind.value = null }

// ── context menu ─────────────────────────────────────────────────────────────
// Right-clicking an entry selects it first; the event then bubbles up to the
// content area, the ContextMenu trigger, which opens the menu at the pointer.
// A long press opens the menu without a contextmenu event on the item (iOS
// sends none), so the item under the finger is selected when the menu opens.
let pressedPath: string | null = null
function onMenuPointerDown(e: PointerEvent) {
  pressedPath = e.pointerType === 'mouse' ? null
    : (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-path]')?.dataset.path ?? null
}
function onMenuOpen(open: boolean) {
  if (!open || !pressedPath) return
  const entry = entries.value.find(en => en.path === pressedPath)
  pressedPath = null
  if (entry) selectForContextMenu(entry)
}

function selectForContextMenu(entry: Entry) {
  if (!selected.value.has(entry.path)) {
    selected.value = new Set([entry.path])
    selectionAnchor.value = entry.path
  }
}

// ── init ─────────────────────────────────────────────────────────────────────
onMounted(async () => {
  dbPlaces.value = (await trpc.place.list.query()) as Place[]
  const folder = takeFolderFocus()
  if (folder) void openBookmark(folder)
  else if (allPlaces.value.length > 0) selectPlace(allPlaces.value[0]!)
  void hydrateInterruptedUploads()
})

// The open file manager (outside the desktop, where a new window opens
// instead) goes to a folder a notification asks for.
watch(pendingFolder, path => {
  if (!path || props.desktopWindow || !dbPlaces.value.length) return
  const folder = takeFolderFocus()
  if (folder) void openBookmark(folder)
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
      :settings-active="showShared"
      :bookmarks="bookmarks"
      :missing-bookmarks="missingBookmarks"
      :current-path="currentPath"
      :has-trash="hasTrash"
      :trash-active="trashOpen"
      @open-settings="openSettings()"
      @open-trash="openTrash"
      @open-bookmark="openBookmark"
      @drop-into="moveInto"
      @add-bookmarks="dirs => setBookmarks(dirs.reduce((list, d) => isBookmarked(list, d) ? list : toggleBookmark(list, d), bookmarks))"
      @rename-bookmark="renamingBookmark = $event"
      @move-bookmark="(path, delta) => setBookmarks(moveBookmark(bookmarks, path, delta))"
      @remove-bookmark="path => setBookmarks(toggleBookmark(bookmarks, path))"
      @select="selectPlace($event); sidebarOpen = false"
      @open-properties="propertiesPlace = $event"
    />

    <div class="flex-1 flex flex-col min-w-0">

      <!-- Settings (display, shared links) replace the files while open -->
      <template v-if="showShared">
        <div class="flex items-center gap-1.5 px-3 py-2 border-b border-base-300 bg-base-200 flex-shrink-0 h-11 sm:hidden" @click.stop>
          <Button variant="ghost" size="icon-sm" @click="sidebarOpen = !sidebarOpen" :aria-label="t('ui.files.FileToolbar.togglePlacesSidebar')"
            :class="sidebarOpen ? 'text-primary bg-primary/10' : 'text-base-content/70 hover:text-base-content hover:bg-base-200'">
            <MenuIcon class="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>
        <div class="flex-1 overflow-auto p-4 sm:p-8" @click.stop>
          <div v-if="trashOpen" class="max-w-2xl">
            <h2 class="mb-4 text-lg font-semibold">{{ t('files.trash.title') }}</h2>
            <TrashView />
          </div>
          <div v-else class="max-w-2xl">
            <h2 class="mb-4 text-lg font-semibold">{{ t('ui.files.PlacesSidebar.settings') }}</h2>
            <Tabs :model-value="settingsTab ?? 'display'" @update:model-value="v => settingsTab = v === 'shared' ? 'shared' : 'display'">
              <TabsList :aria-label="t('ui.files.PlacesSidebar.settings')" class="mb-6">
                <TabsTrigger value="display">{{ t('files.display.title') }}</TabsTrigger>
                <TabsTrigger value="shared">{{ t('ui.files.PlacesSidebar.sharedLinks') }}</TabsTrigger>
              </TabsList>
              <TabsContent value="display"><DisplaySettings /></TabsContent>
              <TabsContent value="shared"><SharedLinksSection /></TabsContent>
            </Tabs>
          </div>
        </div>
      </template>

      <template v-else>
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
        @open="openEntry"
        @start-rename="startRename"
        @download="downloadSelected"
        @open-permissions="openPermissions"
        @share="openShare"
        @delete="doDelete()"
        @create-folder="createFolder"
        @create-file="createFile"
        @upload-click="fileInput?.click()"
        @paste="doPaste"
        @refresh="refresh"
        @update:view-mode="setFilePrefs({ view: $event })"
        @open-display-settings="openSettings('display')"
        :bookmarked="currentBookmarked"
        :to-trash="selectionToTrash"
        @toggle-bookmark="currentPath && toggleBookmarkAt(currentPath)"
        @drop-into="moveInto"
        @toggle-sidebar="sidebarOpen = !sidebarOpen"
        @search="handleSearch"
      />

      <!-- Content area -->
      <ContextMenu @update:open="onMenuOpen">
      <ContextMenuTrigger as-child :disabled="!currentPath && selected.size === 0" @pointerdown.capture="onMenuPointerDown">
      <div
        class="flex-1 overflow-auto relative"
        @dragenter="handleDragEnter"
        @dragleave="handleDragLeave"
        @dragover.capture="clearDragHint"
        @dragover="handleDragOver"
        @drop.prevent="handleDrop"
      >
        <!-- Drag overlay -->
        <div v-if="dragOver && currentPath && dragKind"
          class="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-primary/10 border-2 border-dashed border-primary rounded-sm pointer-events-none select-none">
          <CopyIcon v-if="dragKind === 'copy'" class="w-10 h-10 text-primary opacity-80" aria-hidden="true" />
          <FolderInputIcon v-else-if="dragKind === 'move'" class="w-10 h-10 text-primary opacity-80" aria-hidden="true" />
          <UploadIcon v-else class="w-10 h-10 text-primary opacity-80" aria-hidden="true" />
          <span class="text-sm text-primary font-medium">
            {{ dragKind === 'copy' ? t('ui.files.FileBrowserPanel.dropToCopy') : dragKind === 'move' ? t('ui.files.FileBrowserPanel.dropToMove') : t('ui.files.FileBrowserPanel.dropToUpload') }}
          </span>
          <span v-if="dragKind === 'move'" class="text-xs text-primary/80">{{ t('ui.files.FileBrowserPanel.dropCopyHint') }}</span>
        </div>

        <!-- Loading -->
        <LoadingState v-if="loading" variant="block" />

        <!-- Error -->
        <div v-else-if="error" class="flex items-center gap-2 text-primary text-sm p-6">
          <TriangleAlertIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
          {{ error }}
        </div>

        <!-- No place selected -->
        <div v-else-if="!currentPath" class="flex items-center justify-center h-full text-base-content/70 select-none">
          <div class="text-center space-y-2">
            <FolderGlyph class="w-10 h-10 mx-auto opacity-20" />
            <p class="text-sm">{{ t('ui.files.FileBrowserPanel.selectAPlace') }}</p>
          </div>
        </div>

        <!-- Search results -->
        <div v-else-if="isSearchMode" class="p-4">
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm text-base-content/80">
              <span v-if="searchLoading">{{ t('ui.files.FileBrowserPanel.searching') }}</span>
              <span v-else>{{ t('uip.files.FileBrowserPanel.resultFor', { p0: searchResults.length, p1: searchResults.length === 1 ? '' : 's' }) }}<span class="font-medium text-base-content">{{ searchQuery }}</span>"</span>
            </span>
          </div>
          <LoadingState v-if="searchLoading" variant="compact" :label="LOADING.searching" />
          <div v-else-if="!searchResults.length" class="text-center py-8 text-sm text-base-content/70">{{ t('ui.files.FileBrowserPanel.noResultsFound') }}</div>
          <div v-else class="divide-y divide-base-300 rounded-box border border-base-300 overflow-hidden">
            <Item v-for="r in searchResults" :key="r.path" as="button"
              @click="navigateToSearchResult(r)"
              class="w-full flex-nowrap gap-3 rounded-none px-4 py-2.5 text-left hover:bg-base-200">
              <!-- directory icon -->
              <FileTypeIcon v-if="r.isDir" :name="r.name" dir class="w-4 h-4 shrink-0" aria-hidden="true" />
              <!-- file icon -->
              <FileTypeIcon v-else :name="r.name" class="w-4 h-4 shrink-0" aria-hidden="true" />
              <div class="flex-1 min-w-0">
                <div class="text-sm text-base-content font-medium truncate">{{ r.name }}</div>
                <div class="text-xs text-base-content/70 font-mono truncate">{{ r.relativePath }}</div>
              </div>
            </Item>
          </div>
        </div>

        <!-- Empty directory (and no uploads in progress) -->
        <div v-else-if="entries.length === 0 && activeUploads.length === 0" class="flex items-center justify-center h-full text-base-content/70 select-none">
          <div class="text-center space-y-2">
            <UploadIcon class="w-10 h-10 mx-auto opacity-20" aria-hidden="true" />
            <p class="text-sm">{{ t('ui.files.FileBrowserPanel.thisFolderIsEmpty') }}</p>
            <p class="text-xs">{{ t('ui.files.FileBrowserPanel.dragFilesHereOrUse') }} <strong class="text-base-content/80">{{ t('ui.files.FileBrowserPanel.upload') }}</strong> / <strong class="text-base-content/80">{{ t('ui.files.FileBrowserPanel.newFolder') }}</strong> above.</p>
          </div>
        </div>

        <!-- Has entries (or uploads in progress) -->
        <template v-else>
          <!-- Filter bar (Cmd/Ctrl+K) -->
          <div v-if="showFilter" class="sticky top-0 z-20 px-3 py-2 bg-base-100 border-b border-base-300 flex items-center gap-2">
            <SearchIcon class="w-3.5 h-3.5 text-base-content/70 shrink-0" aria-hidden="true" />
            <Input
              ref="filterInput"
              v-model="filterQuery"
              :placeholder="t('ui.files.FileBrowserPanel.filterByName')"
              :aria-label="t('ui.files.FileBrowserPanel.filterByName2')"
              @keydown.escape="closeFilter"
              class="h-7 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
            <span v-if="filterQuery" class="text-2xs text-base-content/70">{{ displayEntries.length }} of {{ sortedEntries.length }}</span>
            <Button variant="ghost" size="icon-xs" @click="closeFilter" class="text-base-content/70 hover:text-base-content">
              <XIcon class="w-3.5 h-3.5" aria-hidden="true" />
            </Button>
          </div>

          <!-- Grid view -->
          <FileGridView
            @drag-start="onEntryDragStart"
            @drop-into="moveInto"
            v-if="viewMode === 'grid'"
            :entries="displayEntries"
            :selected="selected"
            :renaming-path="renamingPath"
            :rename-value="renameValue"
            :pending-paths="pendingPaths"
            :creating-folder="creatingFolder"
            :creating-file="creatingFile"
            :upload-tasks="activeUploads"
            @card-click="handleGridCardClick"
            @card-dbl-click="handleGridCardDblClick"
            @select-entry="selectEntry"
            @contextmenu="selectForContextMenu"
            @start-rename="startRename"
            @commit-rename="commitRename"
            @cancel-rename="cancelRename"
            @update:rename-value="renameValue = $event"
            @open-file="openFile"
          />

          <!-- List view -->
          <FileListView
            @drag-start="onEntryDragStart"
            @drop-into="moveInto"
            v-else
            :entries="displayEntries"
            :sort-field="sortField"
            :sort-dir="sortDir"
            :columns="filePrefs.columns"
            @set-sort="onHeaderSort"
            :selected="selected"
            :renaming-path="renamingPath"
            :rename-value="renameValue"
            :pending-paths="pendingPaths"
            :creating-folder="creatingFolder"
            :creating-file="creatingFile"
            :upload-tasks="activeUploads"
            @row-click="handleRowClick"
            @row-dbl-click="handleRowDblClick"
            @select-entry="selectEntry"
            @contextmenu="selectForContextMenu"
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
      </ContextMenuTrigger>
      <ContextMenuContent class="min-w-[200px]">
        <!-- Selection-dependent actions, in a desktop file manager's order:
             open, move, change, remove, then the item's details. -->
        <template v-if="selected.size > 0">
          <template v-if="selected.size === 1">
            <ContextMenuItem @select="openEntry(selectedEntries[0]!)">
              <EyeIcon /> {{ selectedEntries[0]?.type === 'file' ? t('ui.files.FileBrowserPanel.view') : t('ui.files.FileBrowserPanel.open') }}<ContextMenuShortcut>Enter</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem v-if="selectedEntries[0]?.type === 'file'" @select="downloadSelected()"><DownloadIcon /> {{ t('ui.files.FileBrowserPanel.download') }}</ContextMenuItem>
            <ContextMenuSeparator />
          </template>
          <ContextMenuItem @select="doCut()"><ScissorsIcon /> {{ t('ui.files.FileBrowserPanel.cut') }}<ContextMenuShortcut>Ctrl+X</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem @select="doCopy()"><CopyIcon /> {{ t('ui.files.FileBrowserPanel.copy') }}<ContextMenuShortcut>Ctrl+C</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuSeparator />
          <template v-if="selected.size === 1">
            <ContextMenuItem @select="startRename(selectedEntries[0]!)"><PencilIcon /> {{ t('ui.files.FileBrowserPanel.rename') }}<ContextMenuShortcut>F2</ContextMenuShortcut></ContextMenuItem>
            <ContextMenuItem @select="openShare()"><Share2Icon /> {{ t('ui.files.FileBrowserPanel.share') }}</ContextMenuItem>
          </template>
          <ContextMenuItem @select="doZip()"><ArchiveIcon /> {{ t('ui.files.FileBrowserPanel.compressToZip') }}</ContextMenuItem>
          <ContextMenuItem
            v-if="selected.size === 1 && selectedEntries[0]?.type === 'file' && selectedEntries[0]?.name.toLowerCase().endsWith('.zip')"
            @select="doUnzip()"
          ><PackageOpenIcon /> {{ t('ui.files.FileBrowserPanel.extractHere') }}</ContextMenuItem>
          <template v-if="selected.size === 1">
            <ContextMenuItem v-if="selectedEntries[0]?.type === 'dir'" @select="toggleBookmarkAt(selectedEntries[0]!.path)">
              <BookmarkIcon /> {{ isBookmarked(bookmarks, selectedEntries[0]!.path) ? t('files.bookmarks.remove') : t('files.bookmarks.add') }}
            </ContextMenuItem>
            <ContextMenuItem @select="copySelectedPath()"><ClipboardCopyIcon /> {{ t('files.copyPath.menu') }}</ContextMenuItem>
          </template>
          <ContextMenuSeparator />
          <ContextMenuItem :variant="selectionToTrash ? undefined : 'destructive'" @select="doDelete()">
            <Trash2Icon /> {{ selectionToTrash ? t('files.trash.moveToTrash') : t('ui.files.FileBrowserPanel.delete') }}<ContextMenuShortcut>Del</ContextMenuShortcut>
          </ContextMenuItem>
          <template v-if="selected.size === 1">
            <ContextMenuSeparator />
            <ContextMenuItem @select="openPermissions()"><KeyRoundIcon /> {{ t('ui.files.FileBrowserPanel.permissions') }}</ContextMenuItem>
            <ContextMenuItem @select="openProperties()"><InfoIcon /> {{ t('ui.files.FileBrowserPanel.properties') }}<ContextMenuShortcut>Alt+Enter</ContextMenuShortcut></ContextMenuItem>
          </template>
          <ContextMenuSeparator v-if="currentPath" />
        </template>

        <!-- General actions -->
        <template v-if="currentPath">
          <ContextMenuItem @select="createFolder()"><FolderPlusIcon /> {{ t('ui.files.FileBrowserPanel.newFolder') }}</ContextMenuItem>
          <ContextMenuItem @select="createFile()"><FilePlusIcon /> {{ t('ui.files.FileBrowserPanel.newFile') }}</ContextMenuItem>
          <ContextMenuItem @select="fileInput?.click()"><UploadIcon /> {{ t('ui.files.FileBrowserPanel.upload') }}</ContextMenuItem>
          <ContextMenuItem v-if="clipboard" :class="clipboard.mode === 'cut' ? 'text-warning' : 'text-primary'" @select="doPaste()">
            <ClipboardPasteIcon class="text-current" />
            {{ t('uip.files.FileBrowserPanel.paste', { p0: clipboard.mode === 'cut' ? '(move)' : '' }) }}<ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @select="refresh()"><RefreshCwIcon /> {{ t('ui.files.FileBrowserPanel.refresh') }}</ContextMenuItem>
        </template>
      </ContextMenuContent>
      </ContextMenu>
      <FolderStatusBar :path="currentPath" :items="displayEntries.length" :selected="selected.size" />
      </template>

    </div>
  </div>

  <input ref="fileInput" type="file" multiple class="hidden" @change="handleFileInput" />

  <FilePermissionsDialog
    v-if="permDialogPath"
    :path="permDialogPath"
    @close="permDialogPath = null"
  />

  <ShareLinkModal
    v-if="shareTarget"
    :path="shareTarget.path"
    :name="shareTarget.name"
    @close="shareTarget = null"
  />

  <FilePreviewModal
    v-if="previewEntry"
    :entry="previewEntry"
    @close="previewEntry = null"
  />

  <RenameBookmarkModal
    v-if="renamingBookmark"
    :bookmark="renamingBookmark"
    @save="label => { setBookmarks(renameBookmark(bookmarks, renamingBookmark!.path, label)); renamingBookmark = null }"
    @close="renamingBookmark = null"
  />

  <FilePropertiesModal
    v-if="propertiesEntry"
    :entry="propertiesEntry"
    @close="propertiesEntry = null"
    @open-permissions="path => { propertiesEntry = null; permDialogPath = path }"
  />

  <FilePropertiesModal
    v-if="propertiesPlace"
    :place="propertiesPlace"
    @close="propertiesPlace = null"
  />
</template>
