// Ordering and filtering of a file manager listing (#196). Folders always come
// first; the rest follows the chosen field and direction.

export type SortField = 'name' | 'modified' | 'size' | 'type'
export type SortDir = 'asc' | 'desc'
export interface FileSort { field: SortField; dir: SortDir }

export type Column = 'size' | 'modified' | 'type'
export const COLUMNS: readonly Column[] = ['size', 'modified', 'type']

interface Sortable { name: string; type: 'dir' | 'file'; size: number | null; mtime: string }

/** The sort menu, in order: each choice and the sort it applies. */
export const SORT_CHOICES = [
  { id: 'az', sort: { field: 'name', dir: 'asc' } },
  { id: 'za', sort: { field: 'name', dir: 'desc' } },
  { id: 'lastModified', sort: { field: 'modified', dir: 'desc' } },
  { id: 'firstModified', sort: { field: 'modified', dir: 'asc' } },
  { id: 'size', sort: { field: 'size', dir: 'desc' } },
  { id: 'type', sort: { field: 'type', dir: 'asc' } },
] as const satisfies readonly { id: string; sort: FileSort }[]

export type SortChoice = typeof SORT_CHOICES[number]['id']

/** The menu choice showing the current sort. Size and type stay checked whichever way a header click turned them. */
export function choiceFor(sort: FileSort): SortChoice {
  if (sort.field === 'size') return 'size'
  if (sort.field === 'type') return 'type'
  return SORT_CHOICES.find(c => c.sort.field === sort.field && c.sort.dir === sort.dir)?.id ?? 'az'
}

/** A click on a column header: the same field flips its direction, another one starts from its natural direction. */
export function headerSort(current: FileSort, field: SortField): FileSort {
  if (current.field === field) return { field, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { field, dir: field === 'name' || field === 'type' ? 'asc' : 'desc' }
}

/** Lowercase extension without the dot, '' for none (a leading dot alone is a hidden name, not an extension). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isHidden(name: string): boolean {
  return name.startsWith('.')
}

const byName = (a: Sortable, b: Sortable) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

export function sortEntries<T extends Sortable>(entries: readonly T[], sort: FileSort): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    let cmp = 0
    if (sort.field === 'size') cmp = (a.size ?? -1) - (b.size ?? -1)
    else if (sort.field === 'modified') cmp = new Date(a.mtime).getTime() - new Date(b.mtime).getTime()
    else if (sort.field === 'type') cmp = extensionOf(a.name).localeCompare(extensionOf(b.name))
    if (cmp === 0) return byName(a, b) * (sort.field === 'name' ? sign : 1)
    return cmp * sign
  })
}

export function visibleEntries<T extends { name: string }>(entries: readonly T[], showHidden: boolean): T[] {
  return showHidden ? [...entries] : entries.filter(e => !isHidden(e.name))
}
