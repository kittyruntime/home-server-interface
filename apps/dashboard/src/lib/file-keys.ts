// Moving through a folder from the keyboard, as in a file explorer: arrows
// step through the items (Shift extends the selection), Home and End jump to
// the ends, and typing a few letters jumps to the first matching name.

const STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/**
 * The index a navigation key leads to from current (-1: nothing selected yet),
 * clamped to the list; null when the key does not navigate, -1 for an empty list.
 */
export function moveIndex(current: number, length: number, key: string): number | null {
  if (key !== 'Home' && key !== 'End' && !(key in STEP)) return null
  if (length === 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  const step = STEP[key]!
  if (current < 0) return step > 0 ? 0 : length - 1
  return Math.min(length - 1, Math.max(0, current + step))
}

/** The first name starting with prefix (case ignored), or -1. */
export function typeAhead(names: string[], prefix: string): number {
  const p = prefix.toLowerCase()
  return names.findIndex(n => n.toLowerCase().startsWith(p))
}

/**
 * Whether a file manager answers keys: always on its own, only the one in the
 * front window on the desktop (several Files windows listen to the same keys).
 */
export function ownsKeyboard(el: { closest(selector: string): unknown } | null, desktopWindow: boolean): boolean {
  if (!desktopWindow) return true
  return !!el?.closest('[data-window-focused]')
}

/** How long typed letters add up before a new search starts. */
export const TYPE_AHEAD_MS = 1000
