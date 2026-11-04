// Bookmarked folders of the file manager (#199): pure list operations, kept in
// the account's display preferences by ./file-prefs.ts.

export interface Bookmark { path: string; label?: string }

export const MAX_BOOKMARKS = 50
export const MAX_LABEL = 64

/** Valid, unique bookmarks in their order, capped. */
export function normalizeBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Bookmark[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const { path, label } = item as Record<string, unknown>
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || seen.has(path)) continue
    seen.add(path)
    const clean = typeof label === 'string' ? label.trim().slice(0, MAX_LABEL) : ''
    out.push(clean ? { path, label: clean } : { path })
    if (out.length === MAX_BOOKMARKS) break
  }
  return out
}

export function isBookmarked(list: readonly Bookmark[], path: string): boolean {
  return list.some(b => b.path === path)
}

/** Adds at the end, or removes when already there. */
export function toggleBookmark(list: readonly Bookmark[], path: string): Bookmark[] {
  if (isBookmarked(list, path)) return list.filter(b => b.path !== path)
  return normalizeBookmarks([...list, { path }])
}

export function renameBookmark(list: readonly Bookmark[], path: string, label: string): Bookmark[] {
  return normalizeBookmarks(list.map(b => (b.path === path ? { path, label } : b)))
}

/** Moves a bookmark up (-1) or down (+1); a move past either end leaves the list as it is. */
export function moveBookmark(list: readonly Bookmark[], path: string, delta: -1 | 1): Bookmark[] {
  const from = list.findIndex(b => b.path === path)
  const to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/** The label shown: the custom one, else the folder's name. */
export function bookmarkLabel(b: Bookmark): string {
  if (b.label) return b.label
  const name = b.path.replace(/\/+$/, '').split('/').pop()
  return name || '/'
}

/** The place a path belongs to: the one with the longest matching path. */
export function placeFor<T extends { path: string }>(places: readonly T[], path: string): T | null {
  let best: T | null = null
  for (const p of places) {
    const root = p.path.replace(/\/+$/, '') || '/'
    const inside = path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
    if (inside && (!best || root.length > best.path.replace(/\/+$/, '').length)) best = p
  }
  return best
}
