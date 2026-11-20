import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { subscribeMetrics, type LiveMetrics } from '../../../lib/live-metrics'
import { now, type Source } from '../../../lib/widget-data'

// The CPU, memory and network widgets read the shared live poller and keep one
// common history, so each starts full when added.

const HIST = 40
const last = shallowRef<LiveMetrics | undefined>(undefined)
const at = ref(0)
export const cpuHist = ref<number[]>([])
export const memHist = ref<number[]>([])
export const rxHist = ref<number[]>([])
export const txHist = ref<number[]>([])
let users = 0
let stop: (() => void) | null = null

const push = (list: typeof cpuHist, v: number) => { list.value = [...list.value.slice(-(HIST - 1)), v] }

function onSample(m: LiveMetrics) {
  last.value = m
  at.value = Date.now()
  push(cpuHist, m.cpu)
  push(memHist, m.memory.percent)
  push(rxHist, m.network.rx)
  push(txHist, m.network.tx)
}

export function useLive(): Source<LiveMetrics> {
  users++
  if (!stop) stop = subscribeMetrics(onSample)
  onScopeDispose(() => {
    users--
    if (users === 0 && stop) { stop(); stop = null }
  })
  return {
    data: last, error: ref(null), loading: computed(() => !last.value), at,
    stale: computed(() => at.value > 0 && now.value - at.value > 15_000),
    refresh: async () => {},
  }
}
