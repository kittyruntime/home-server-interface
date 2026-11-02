import { trpc } from './trpc'

export type LiveMetrics = Awaited<ReturnType<typeof trpc.system.metrics.query>>

// One system.metrics poller shared by every view that shows live usage (the
// dashboard widgets, Monitoring): each poll moves the backend's CPU and
// network delta window, so separate pollers made each other's values noisy.
// It runs while something listens, and skips its turn while the tab is hidden.
const POLL_MS = 3000
const listeners = new Set<(m: LiveMetrics) => void>()
let timer: ReturnType<typeof setInterval> | null = null
let last: LiveMetrics | null = null

async function poll() {
  if (typeof document !== 'undefined' && document.hidden) return
  try {
    last = await trpc.system.metrics.query()
  } catch {
    return
  }
  for (const fn of listeners) fn(last)
}

/** Calls fn with each new sample (the latest one at once, if any). Returns the unsubscribe. */
export function subscribeMetrics(fn: (m: LiveMetrics) => void): () => void {
  listeners.add(fn)
  if (last) fn(last)
  if (!timer) {
    void poll()
    timer = setInterval(poll, POLL_MS)
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
