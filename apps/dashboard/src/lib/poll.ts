import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue'

export interface PollOptions {
  /** Run once on mount (default true). */
  immediate?: boolean
  /** Also run when the window gets the focus back (default false). */
  onFocus?: boolean
}

// Keeps a component's data current while it is on screen. One poller for the
// whole dashboard instead of a hand-rolled setInterval per component:
// - nothing runs while the tab is hidden, and coming back to it refreshes at
//   once if a beat was missed, so a returning user never reads stale data;
// - a slow server never stacks requests: a beat is skipped while the previous
//   call is still in flight;
// - inside a <KeepAlive>, a view put aside stops polling and catches up when
//   it is shown again.
export function usePoll(fn: () => unknown, everyMs: number, opts: PollOptions = {}) {
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let lastAt = 0
  let parked = false

  async function run() {
    if (running) return
    running = true
    lastAt = Date.now()
    try { await fn() } catch { /* the caller shows its own errors */ } finally { running = false }
  }
  const beat = () => { if (!document.hidden && !parked) void run() }
  const onVisible = () => { if (!document.hidden && !parked && Date.now() - lastAt >= everyMs) void run() }
  const onFocus = () => { if (!document.hidden && !parked) void run() }

  onMounted(() => {
    if (opts.immediate !== false) void run()
    timer = setInterval(beat, everyMs)
    document.addEventListener('visibilitychange', onVisible)
    if (opts.onFocus) window.addEventListener('focus', onFocus)
  })
  onDeactivated(() => { parked = true })
  onActivated(() => {
    if (!parked) return // the first activation is the mount
    parked = false
    onVisible()
  })
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onFocus)
  })

  return { refresh: run }
}
