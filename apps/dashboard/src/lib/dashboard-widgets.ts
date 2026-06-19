import { ref, computed, onMounted, onUnmounted, type Ref } from 'vue'
import { trpc } from './trpc'

export type WidgetType = 'cpu' | 'memory' | 'network' | 'containers'
export interface Widget { id: string; type: WidgetType; cols: 1 | 2 }

interface Metrics {
  cpu:     number
  memory:  { total: number; used: number; percent: number }
  network: { rx: number; tx: number }
  uptime:  number
}

type ContainerStatus = { status: string }

export const CATALOG: { type: WidgetType; label: string }[] = [
  { type: 'cpu',        label: 'CPU'        },
  { type: 'memory',     label: 'Memory'     },
  { type: 'network',    label: 'Network'    },
  { type: 'containers', label: 'Containers' },
]

const SK = 'dashboard'

const DEFAULT_WIDGETS: Widget[] = [
  { id: 'w-cpu',  type: 'cpu',        cols: 1 },
  { id: 'w-mem',  type: 'memory',     cols: 1 },
  { id: 'w-net',  type: 'network',    cols: 1 },
  { id: 'w-ctr',  type: 'containers', cols: 1 },
]

function loadWidgets(): Widget[] {
  try {
    const raw = localStorage.getItem(SK)
    if (raw) return JSON.parse(raw) as Widget[]
  } catch { /* ignore */ }
  return DEFAULT_WIDGETS.map(w => ({ ...w }))
}

function saveWidgets(ws: Widget[]) {
  localStorage.setItem(SK, JSON.stringify(ws))
}

function pushHist(arr: Ref<number[]>, val: number, hist: number) {
  arr.value.push(val)
  if (arr.value.length > hist) arr.value.shift()
}

export function spark(
  vals: number[],
  lo = 0,
  hi?: number,
): { line: string } {
  if (vals.length < 2) return { line: '' }
  const max = hi ?? Math.max(...vals, 1)
  const min = lo
  const W = 100
  const H = 40
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W
    const y = H - ((v - min) / (max - min || 1)) * H
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return { line: `M${pts.join('L')}` }
}

export function fmtBytes(b: number): string {
  if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + ' MB/s'
  if (b >= 1024)      return (b / 1024).toFixed(1) + ' KB/s'
  return b + ' B/s'
}

export function fmtMem(b: number): string {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + ' GB'
  if (b >= 1_048_576)     return (b / 1_048_576).toFixed(0) + ' MB'
  return (b / 1024).toFixed(0) + ' KB'
}

export function memColor(percent: number): string {
  if (percent > 85) return 'var(--c-accent)'
  if (percent > 65) return 'var(--c-warning)'
  return 'var(--c-success)'
}

export function useDashboardWidgets() {
  const widgets    = ref<Widget[]>(loadWidgets())
  const metrics    = ref<Metrics | null>(null)
  const containers = ref<ContainerStatus[]>([])

  const HIST = 30
  const cpuHist = ref<number[]>([])
  const rxHist  = ref<number[]>([])
  const txHist  = ref<number[]>([])

  let timer: ReturnType<typeof setInterval> | null = null

  async function fetchMetrics() {
    try {
      const m = await trpc.system.metrics.query()
      metrics.value = m as Metrics
      pushHist(cpuHist, m.cpu, HIST)
      pushHist(rxHist,  m.network.rx, HIST)
      pushHist(txHist,  m.network.tx, HIST)
    } catch { /* ignore */ }
  }

  async function fetchContainers() {
    try {
      containers.value = (await trpc.container.app.list.query()) as ContainerStatus[]
    } catch { /* ignore */ }
  }

  onMounted(() => {
    fetchMetrics()
    fetchContainers()
    timer = setInterval(fetchMetrics, 3000)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })

  const uptimeStr = computed(() => {
    const s = metrics.value?.uptime ?? 0
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d > 0) return `up ${d}d ${h}h`
    if (h > 0) return `up ${h}h ${m}m`
    return `up ${m}m`
  })

  const ctrRunning = computed(() => containers.value.filter(c => c.status === 'running').length)
  const ctrStopped = computed(() => containers.value.filter(c => c.status === 'stopped').length)
  const ctrError   = computed(() => containers.value.filter(c => c.status === 'error').length)

  function toggleCols(w: Widget) {
    w.cols = w.cols === 1 ? 2 : 1
    saveWidgets(widgets.value)
  }

  function removeWidget(id: string) {
    widgets.value = widgets.value.filter(w => w.id !== id)
    saveWidgets(widgets.value)
  }

  function addWidget(type: WidgetType) {
    const id = `w-${type}-${Date.now()}`
    widgets.value.push({ id, type, cols: 1 })
    saveWidgets(widgets.value)
  }

  return {
    widgets, metrics, containers,
    cpuHist, rxHist, txHist,
    uptimeStr, ctrRunning, ctrStopped, ctrError,
    toggleCols, removeWidget, addWidget,
  }
}
