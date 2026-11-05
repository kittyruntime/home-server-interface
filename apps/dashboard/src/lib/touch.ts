// Whether a click came from a finger (or a pen) rather than a mouse. A touch
// screen has no double click nor hover, so the file manager opens on a tap.
//
// iOS Safari can report the click that follows a tap as pointerType "mouse",
// while the pointerdown before it says "touch": the pointerdown is what counts.
// Without either (keyboard, older browser), the device's primary pointer decides.

const RECENT_MS = 1000
let lastDown: { type: string; at: number } | null = null

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pointerdown', e => { lastDown = { type: e.pointerType, at: e.timeStamp } }, { capture: true, passive: true })
}

const isFinger = (type: string) => type === 'touch' || type === 'pen'

export function isTouchClick(e: MouseEvent): boolean {
  if (lastDown && e.timeStamp - lastDown.at < RECENT_MS) return isFinger(lastDown.type)
  const type = (e as PointerEvent).pointerType
  if (type) return isFinger(type)
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

/** Tests only: what the last pointerdown was. */
export function setLastPointerDownForTests(type: string | null, at = 0) {
  lastDown = type === null ? null : { type, at }
}
