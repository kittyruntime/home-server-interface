import { onMounted, onUnmounted } from 'vue'

/* One shared Escape listener; only the topmost registered layer closes.
   Prevents a single keypress from dismissing a whole stack of overlays
   (e.g. a confirm dialog sitting on top of the launchpad). */
const stack: Array<() => void> = []

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  stack[stack.length - 1]?.()
}

/** Register `close` as the current top layer; call the returned function to unregister. */
export function pushEscLayer(close: () => void): () => void {
  if (stack.length === 0) window.addEventListener('keydown', onKeydown)
  stack.push(close)
  return () => {
    const i = stack.lastIndexOf(close)
    if (i !== -1) stack.splice(i, 1)
    if (stack.length === 0) window.removeEventListener('keydown', onKeydown)
  }
}

/** Escape layer tied to the component's lifetime (modals, launchpad). */
export function useEscLayer(close: () => void) {
  let release: (() => void) | null = null
  onMounted(() => { release = pushEscLayer(close) })
  onUnmounted(() => { release?.(); release = null })
}
