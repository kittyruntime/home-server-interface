import { ref } from 'vue'
import { tr } from './tr'

// Dragging files and folders inside the file manager, also from one window to
// another: onto a folder, a place, a crumb or another window's open folder
// moves them there (copies them with Ctrl or Alt held); a folder onto the Bookmarks group bookmarks it.
// The dragged paths live here, shared by the list, the grid, the toolbar and
// the sidebar; the dataTransfer type only tells an internal drag from files
// dropped from the computer (which upload).

export const DRAG_TYPE = 'application/x-hsi-paths'

export interface FileDrag { paths: string[]; dirs: string[] }
export type DropAction = 'move' | 'copy'

/** Ctrl (Option on a Mac reports altKey) copies; a plain drop moves. */
export function dropAction(e: { ctrlKey: boolean; altKey: boolean }): DropAction {
  return e.ctrlKey || e.altKey ? 'copy' : 'move'
}

export const fileDrag = ref<FileDrag | null>(null)

/** What the drag preview says: the item's name, or how many items. */
export function dragLabel(paths: string[]): string {
  if (paths.length === 1) return paths[0]!.split('/').pop() || paths[0]!
  return tr('lib.file_drag.items', `${paths.length} items`, { count: paths.length })
}

// A small chip under the pointer instead of the browser's ghost of the row:
// with several items selected, the ghost showed only the one under the pointer.
function setDragPreview(dt: DataTransfer, paths: string[]): void {
  if (typeof document === 'undefined' || typeof dt.setDragImage !== 'function') return
  const chip = document.createElement('div')
  chip.textContent = dragLabel(paths)
  chip.className = 'fixed -top-24 left-0 max-w-64 truncate rounded-field bg-primary px-2.5 py-1 text-xs font-semibold text-primary-content shadow-md'
  document.body.appendChild(chip)
  dt.setDragImage(chip, -12, -8)
  // The browser takes its picture now; the element is not needed after.
  setTimeout(() => chip.remove(), 0)
}

export function startFileDrag(e: DragEvent, paths: string[], dirs: string[]): void {
  fileDrag.value = { paths, dirs }
  if (e.dataTransfer) {
    setDragPreview(e.dataTransfer, paths)
    // Moving or copying into a folder, or linking it as a bookmark.
    e.dataTransfer.effectAllowed = 'all'
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths))
    e.dataTransfer.setData('text/plain', paths.join('\n'))
  }
}

export function endFileDrag(): void {
  fileDrag.value = null
}

/** The drag carries items of this file manager (not files from the computer). */
export function isInternalDrag(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes(DRAG_TYPE) || fileDrag.value !== null
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/**
 * Whether the dragged items can move into dir: never into one of themselves or
 * their insides, and not where they already are (all of them).
 */
export function canDropInto(drag: FileDrag | null, dir: string): boolean {
  if (!drag || drag.paths.length === 0) return false
  for (const p of drag.paths) {
    if (dir === p || dir.startsWith(p === '/' ? '/' : `${p}/`)) return false
  }
  return !drag.paths.every(p => parentOf(p) === dir)
}

/**
 * A set of folders that accept dragged items: `over` is the one hovered, for a
 * highlight; `onDrop` hands the dragged paths over, then the drag ends.
 */
export function useFolderDrop(drop: (dir: string, paths: string[], action: DropAction) => void) {
  const over = ref<string | null>(null)
  function onDragOver(dir: string, e: DragEvent) {
    if (!isInternalDrag(e) || !canDropInto(fileDrag.value, dir)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = dropAction(e)
    over.value = dir
  }
  function onDragLeave(dir: string) {
    if (over.value === dir) over.value = null
  }
  function onDrop(dir: string, e: DragEvent) {
    over.value = null
    const drag = fileDrag.value
    if (!isInternalDrag(e) || !canDropInto(drag, dir)) return
    e.preventDefault()
    e.stopPropagation()
    endFileDrag()
    drop(dir, drag!.paths, dropAction(e))
  }
  return { over, onDragOver, onDragLeave, onDrop }
}
