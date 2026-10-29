import { reactive } from 'vue'
import { trpc, MAINTENANCE_EVENT } from './trpc'
import { nextMaintenanceStep, type MaintenanceStep } from './maintenance-step'
import { lastResultText, lastResultIsProblem } from './update-result'

// Update, restart and reboot overlay (#132). The backend says whether one is
// under way (system.maintenance, public); every tab asks, so they all show the
// overlay, also after a reload, and the server refuses changes meanwhile.

export type MaintenanceKind = 'update' | 'restart' | 'reboot'

export const maintenance = reactive({
  kind: null as MaintenanceKind | null,
  target: null as string | null,
  step: 'scheduled' as MaintenanceStep,
  /** The outcome of an update, once the server is back (admins only). */
  result: null as { text: string; problem: boolean } | null,
  countdown: 0,
})

const IDLE_POLL_MS = 15_000
const ACTIVE_POLL_MS = 2_000
const RELOAD_AFTER_S = 3

let timer: ReturnType<typeof setTimeout> | undefined

function schedule(ms: number) {
  clearTimeout(timer)
  timer = setTimeout(poll, ms)
}

async function ask(): Promise<{ reachable: boolean; state: Awaited<ReturnType<typeof trpc.system.maintenance.query>> }> {
  try {
    return { reachable: true, state: await trpc.system.maintenance.query(undefined, { signal: AbortSignal.timeout(3_000) }) }
  } catch {
    return { reachable: false, state: null }
  }
}

async function poll() {
  const { reachable, state } = await ask()
  if (!maintenance.kind) {
    // Idle: another tab or another user may have started one.
    if (state) enter(state.kind, state.target, 'working')
    else schedule(IDLE_POLL_MS)
    return
  }
  maintenance.step = nextMaintenanceStep(maintenance.step, reachable, !!state)
  if (maintenance.step === 'done') return finish()
  schedule(ACTIVE_POLL_MS)
}

function enter(kind: MaintenanceKind, target: string | null, step: MaintenanceStep) {
  Object.assign(maintenance, { kind, target, step, result: null, countdown: 0 })
  schedule(ACTIVE_POLL_MS)
}

async function finish() {
  if (maintenance.kind === 'update') {
    // update.status is for admins; anyone else just gets the reload.
    const last = await trpc.update.status.query().then(s => s.lastResult, () => null)
    const text = lastResultText(last)
    if (last && text) maintenance.result = { text, problem: lastResultIsProblem(last) }
    // A failed update stays on screen until it has been read.
    if (maintenance.result?.problem) return
  }
  maintenance.countdown = RELOAD_AFTER_S
  const tick = setInterval(() => {
    if (--maintenance.countdown > 0) return
    clearInterval(tick)
    window.location.reload()
  }, 1_000)
}

/** Shows the overlay right away for an operation this tab started. */
export function startMaintenance(kind: MaintenanceKind, target: string | null = null) {
  enter(kind, target, 'scheduled')
}

let watching = false

/** Once, at startup. */
export function watchMaintenance() {
  if (watching) return
  watching = true
  // Asks now instead of at the next idle poll when the server refused a change.
  window.addEventListener(MAINTENANCE_EVENT, () => { if (!maintenance.kind) schedule(0) })
  schedule(0)
}
