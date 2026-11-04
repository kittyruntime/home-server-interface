import { ref } from 'vue'
import { COLUMNS, type Column, type FileSort, type SortDir, type SortField } from './file-sort'

// File manager display preferences (#196): sort, visible columns, hidden files
// and view. Kept in localStorage for an instant read and synced with the
// account by ./preferences.ts, like the appearance.

export interface FilePrefs {
  sortField: SortField
  sortDir: SortDir
  columns: Column[]
  showHidden: boolean
  view: 'list' | 'grid'
}

export const DEFAULT_FILE_PREFS: FilePrefs = {
  sortField: 'name',
  sortDir: 'asc',
  columns: ['size', 'modified'],
  showHidden: false,
  view: 'list',
}

const STORAGE_KEY = 'file-prefs'
const FIELDS: readonly SortField[] = ['name', 'modified', 'size', 'type']

/** Each field falls back to its default on its own, so one bad value never resets the others. */
export function normalizeFilePrefs(raw: unknown): FilePrefs {
  const v = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const d = DEFAULT_FILE_PREFS
  const columns = Array.isArray(v.columns)
    ? COLUMNS.filter(c => (v.columns as unknown[]).includes(c))
    : d.columns
  return {
    sortField: FIELDS.includes(v.sortField as SortField) ? v.sortField as SortField : d.sortField,
    sortDir: v.sortDir === 'asc' || v.sortDir === 'desc' ? v.sortDir : d.sortDir,
    columns,
    showHidden: typeof v.showHidden === 'boolean' ? v.showHidden : d.showHidden,
    view: v.view === 'list' || v.view === 'grid' ? v.view : d.view,
  }
}

function read(): FilePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return normalizeFilePrefs(raw ? JSON.parse(raw) : null)
  } catch { return { ...DEFAULT_FILE_PREFS } }
}

const filePrefs = ref<FilePrefs>(read())

export function useFilePrefs() {
  function setFilePrefs(patch: Partial<FilePrefs>) {
    filePrefs.value = normalizeFilePrefs({ ...filePrefs.value, ...patch })
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(filePrefs.value)) } catch { /* this session only */ }
  }
  function setSort(sort: FileSort) { setFilePrefs({ sortField: sort.field, sortDir: sort.dir }) }
  return { filePrefs, setFilePrefs, setSort }
}
