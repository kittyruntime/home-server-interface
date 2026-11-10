// Renaming like a file explorer: a double click opens, and a single click on
// the name of the item that is already the only one selected renames it, once
// the double click delay has passed without a second click.

/** Longer than a double click, so the second click of one cancels the rename. */
export const SLOW_CLICK_MS = 500

export function slowClick() {
  let timer: ReturnType<typeof setTimeout> | null = null
  const hasWindow = typeof window !== 'undefined'
  function cancel() {
    if (timer) clearTimeout(timer)
    timer = null
    if (hasWindow) window.removeEventListener('pointerdown', cancel, true)
  }
  function arm(rename: () => void) {
    cancel()
    timer = setTimeout(() => { cancel(); rename() }, SLOW_CLICK_MS)
    // Any next press (the second click of a double click, a click elsewhere)
    // drops the pending rename.
    if (hasWindow) window.addEventListener('pointerdown', cancel, true)
  }
  return { arm, cancel }
}
