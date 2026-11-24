import { shallowRef } from 'vue'
import { trpc } from './trpc'
import { livePaused } from './live-pause'

export type ProcessRow = Awaited<ReturnType<typeof trpc.system.processes.query>>[number]

// One system.processes poller shared by the overview and the Processes
// section, every 3 seconds while one of them is open and the tab is visible.
export const PROC_POLL_MS = 3000

export const procs = shallowRef<ProcessRow[]>([])
export const procsLoaded = shallowRef(false)
export const procsError = shallowRef(false)
/** While true (a stop is being confirmed or sent), refreshes wait. */
export const procsPaused = shallowRef(false)

const listeners = new Set<symbol>()
let timer: ReturnType<typeof setInterval> | null = null

export async function loadProcs(): Promise<void> {
  try {
    procs.value = await trpc.system.processes.query()
    procsError.value = false
  } catch {
    procsError.value = true
  }
  procsLoaded.value = true
}

function poll() {
  if (procsPaused.value || livePaused.value || (typeof document !== 'undefined' && document.hidden)) return
  void loadProcs()
}

/** Starts the poller for one viewer; returns the stop. */
export function subscribeProcs(): () => void {
  const id = Symbol('procs')
  listeners.add(id)
  if (!timer) {
    poll()
    timer = setInterval(poll, PROC_POLL_MS)
  }
  return () => {
    listeners.delete(id)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
