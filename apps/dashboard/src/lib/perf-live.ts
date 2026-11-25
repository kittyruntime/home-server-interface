import { reactive, shallowRef } from 'vue'
import { trpc } from './trpc'
import { pushSample } from './perf-math'
import { livePaused } from './live-pause'
import { sensorKey } from './perf-temps'

export type Perf = Awaited<ReturnType<typeof trpc.system.perf.query>>

// One system.perf poller for the Monitor app, with the last two minutes of
// every curve so that the graphs are full when a resource is picked or the
// section is opened again. It runs while something listens and skips its turn
// while the tab is hidden.
export const POLL_MS = 2000
export const CAPACITY = 60

export const perf = shallowRef<Perf | null>(null)
export const perfError = shallowRef<string | null>(null)
/** Curves by key: cpu, core:N, mem, disk:NAME:busy|read|write, net:NAME:rx|tx,
 *  temp:CHIP:LABEL (temperatures; fans are shown as figures only). */
export const history = reactive<Record<string, number[]>>({})
/** Samples taken so far; moves the graph grid with time. */
export const tick = shallowRef(0)

const listeners = new Set<symbol>()
let timer: ReturnType<typeof setInterval> | null = null
let lastAt = 0

function record(key: string, value: number) {
  pushSample(history[key] ??= [], value, CAPACITY)
}

async function poll() {
  if (livePaused.value || (typeof document !== 'undefined' && document.hidden)) return
  let p: Perf
  try {
    p = await trpc.system.perf.query()
  } catch (e) {
    perfError.value = (e as Error).message || 'error'
    return
  }
  perfError.value = null
  // A long pause (closed window, hidden tab) would draw a false straight line.
  if (lastAt && p.at - lastAt > POLL_MS * 5) for (const k of Object.keys(history)) delete history[k]
  lastAt = p.at
  record('cpu', p.cpu.usage)
  p.cpu.perCore.forEach((v, i) => record(`core:${i}`, v))
  record('mem', p.memory.total ? (p.memory.used / p.memory.total) * 100 : 0)
  for (const d of p.disks) {
    record(`disk:${d.name}:busy`, d.busy)
    record(`disk:${d.name}:read`, d.readBps)
    record(`disk:${d.name}:write`, d.writeBps)
  }
  for (const n of p.nets) {
    record(`net:${n.name}:rx`, n.rxBps)
    record(`net:${n.name}:tx`, n.txBps)
  }
  for (const s of p.sensors ?? []) if (s.kind === 'temp') record(`temp:${sensorKey(s)}`, s.value)
  perf.value = p
  tick.value++
}

/** Starts the poller for one viewer; returns the stop. */
export function subscribePerf(): () => void {
  const id = Symbol('perf')
  listeners.add(id)
  if (!timer) {
    void poll()
    timer = setInterval(poll, POLL_MS)
  }
  return () => {
    listeners.delete(id)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

export const curve = (key: string): number[] => history[key] ?? []

/** One hue per kind of resource, the same in the list and in the detail. */
export const RESOURCE_COLOR = {
  cpu: 'var(--color-primary)',
  mem: 'var(--color-secondary)',
  disk: 'var(--color-success)',
  net: 'var(--color-warning)',
  temp: 'var(--color-error)',
} as const
