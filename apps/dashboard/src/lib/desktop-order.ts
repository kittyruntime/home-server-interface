/**
 * The windows to render, in opening order. Their stacking is their z-index:
 * sorting them would move the focused window's element in the page between
 * pointerdown and pointerup, and the browser then drops the click (the first
 * click on a window in the background did nothing).
 */
export function shownWindows<T extends { minimized: boolean }>(windows: T[]): T[] {
  return windows.filter(w => !w.minimized)
}
