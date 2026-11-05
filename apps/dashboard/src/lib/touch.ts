// Whether a click came from a finger (or a pen) rather than a mouse. A touch
// screen has no double click nor hover, so the file manager opens on a tap.
// Click events are PointerEvents in current browsers; older ones fall back on
// the device's primary pointer.
export function isTouchClick(e: MouseEvent): boolean {
  const type = (e as PointerEvent).pointerType
  if (type) return type === 'touch' || type === 'pen'
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}
