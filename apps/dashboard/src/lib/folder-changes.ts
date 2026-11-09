import { ref } from 'vue'

// Several file manager windows can show the same folders: once a move or copy
// ends, every window showing a folder it changed refreshes, not only the one
// the items were dropped on.

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** The folders a move or copy changed: where the items went, and for a move where they were. */
export function affectedDirs(kind: 'move' | 'copy', paths: string[], dst: string): string[] {
  const dirs = new Set([dst])
  if (kind === 'move') for (const p of paths) dirs.add(parentOf(p))
  return [...dirs]
}

/** The last change; seq grows with each one so a watcher sees repeats too. */
export const folderChanges = ref<{ dirs: string[]; seq: number }>({ dirs: [], seq: 0 })

export function announceFolderChanges(dirs: string[]): void {
  folderChanges.value = { dirs, seq: folderChanges.value.seq + 1 }
}
