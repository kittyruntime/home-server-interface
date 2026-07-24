import { ref, computed, onMounted, onUnmounted, type Ref } from 'vue'
import { trpc } from './trpc'
import { type SmartResult, fetchSmartInto } from './../composables/useSmart'
import { type BlockDev } from './../composables/useStorageData'
import { useAuth } from './auth'

export type WidgetType = 'cpu' | 'memory' | 'network' | 'containers' | 'storage' | 'sysinfo' | 'smart'
export interface Widget { id: string; type: WidgetType; cols: 1 | 2 }

interface Metrics {
  cpu:     number
  memory:  { total: number; used: number; percent: number }
  network: { rx: number; tx: number }
  uptime:  number
}

type ContainerStatus = { status: string }

export type DiskFs  = { device: string; mountPoint: string; fsType: string; total: number; used: number; free: number }
export type Sysinfo = { hostname: string; platform: string; arch: string; release: string; cpuModel: string; cpuCount: number; loadavg: [number, number, number] }

type CatalogEntry = { type: WidgetType; label: string; adminOnly?: boolean }

const CATALOG_ALL: CatalogEntry[] = [
  { type: 'cpu',        label: 'CPU'         },
  { type: 'memory',     label: 'Memory'      },
  { type: 'network',    label: 'Network'     },
  { type: 'containers', label: 'Containers', adminOnly: true },
  { type: 'storage',    label: 'Storage',    adminOnly: true },
  { type: 'sysinfo',    label: 'System',     adminOnly: true },
  { type: 'smart',      label: 'Disk Health', adminOnly: true },
]

/** Widget types selectable given the viewer's role. Admin-only widgets rely on
 *  admin tRPC queries, so they are hidden from non-admins entirely. */
export function catalogFor(isAdmin: boolean): { type: WidgetType; label: string }[] {
  return CATALOG_ALL.filter(c => isAdmin || !c.adminOnly).map(({ type, label }) => ({ type, label }))
}

const SK = 'dashboard'

const ADMIN_TYPES = new Set(CATALOG_ALL.filter(c => c.adminOnly).map(c => c.type))

const DEFAULT_WIDGETS: Widget[] = [
  { id: 'w-cpu',  type: 'cpu',        cols: 1 },
  { id: 'w-mem',  type: 'memory',     cols: 1 },
  { id: 'w-net',  type: 'network',    cols: 1 },
  { id: 'w-ctr',  type: 'containers', cols: 1 },
]

function loadWidgets(isAdmin: boolean): Widget[] {
  try {
    const raw = localStorage.getItem(SK)
    if (raw) return JSON.parse(raw) as Widget[]
  } catch { /* ignore */ }
  return DEFAULT_WIDGETS.filter(w => isAdmin || !ADMIN_TYPES.has(w.type)).map(w => ({ ...w }))
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

export function fmtGB(b: number): string {
  if (b >= 1_099_511_627_776) return (b / 1_099_511_627_776).toFixed(2) + ' TB'
  if (b >= 1_073_741_824)     return (b / 1_073_741_824).toFixed(1) + ' GB'
  return (b / 1_048_576).toFixed(0) + ' MB'
}
export function diskColor(percent: number): string {
  if (percent >= 90) return 'var(--c-accent)'
  if (percent >= 75) return 'var(--c-warning)'
  return 'var(--c-success)'
}

export function useDashboardWidgets() {
  const { isAdmin } = useAuth()

  const widgets    = ref<Widget[]>(loadWidgets(isAdmin.value))
  const metrics    = ref<Metrics | null>(null)
  const containers = ref<ContainerStatus[]>([])
  const disks    = ref<DiskFs[]>([])
  const sysinfo  = ref<Sysinfo | null>(null)
  const smart    = ref<Record<string, SmartResult>>({})
  const smartDevices = ref<string[]>([])

  const HIST = 30
  const cpuHist = ref<number[]>([])
  const rxHist  = ref<number[]>([])
  const txHist  = ref<number[]>([])

  let timer: ReturnType<typeof setInterval> | null = null
  let slowTimer:  ReturnType<typeof setInterval> | null = null
  let smartTimer: ReturnType<typeof setInterval> | null = null

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

  async function fetchDisks() {
    try { disks.value = (await trpc.system.disks.query()).disks as DiskFs[] }
    catch { /* non-admin or worker error → stays empty */ }
  }
  async function fetchSysinfo() {
    try { sysinfo.value = await trpc.system.sysinfo.query() as Sysinfo }
    catch { /* ignore */ }
  }
  async function refreshSmartDevices() {
    try {
      const res = await trpc.system.blockDevices.query() as { devices: BlockDev[] }
      smartDevices.value = (res.devices ?? []).filter(d => d.type === 'disk').map(d => d.name)
    } catch { smartDevices.value = [] }
  }
  async function fetchSmart() {
    if (smartDevices.value.length === 0) await refreshSmartDevices()
    await Promise.all(smartDevices.value.map(d => fetchSmartInto(smart, d)))
  }

  function hasType(t: WidgetType) { return widgets.value.some(w => w.type === t) }

  function syncTimers() {
    const wantSlow  = isAdmin.value && (hasType('storage') || hasType('sysinfo'))
    const wantSmart = isAdmin.value && hasType('smart')

    if (wantSlow && !slowTimer) {
      fetchDisks(); fetchSysinfo()
      slowTimer = setInterval(() => { fetchDisks(); fetchSysinfo() }, 30_000)
    } else if (!wantSlow && slowTimer) {
      clearInterval(slowTimer); slowTimer = null
    }

    if (wantSmart && !smartTimer) {
      fetchSmart()
      smartTimer = setInterval(fetchSmart, 60_000)
    } else if (!wantSmart && smartTimer) {
      clearInterval(smartTimer); smartTimer = null
    }
  }

  onMounted(() => {
    fetchMetrics()
    if (isAdmin.value) fetchContainers()
    timer = setInterval(fetchMetrics, 3000)
    syncTimers()
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
    if (slowTimer)  clearInterval(slowTimer)
    if (smartTimer) clearInterval(smartTimer)
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
    syncTimers()
  }

  function addWidget(type: WidgetType) {
    const id = `w-${type}-${Date.now()}`
    widgets.value.push({ id, type, cols: 1 })
    saveWidgets(widgets.value)
    syncTimers()
  }

  return {
    widgets, metrics, containers,
    disks, sysinfo, smart, smartDevices,
    cpuHist, rxHist, txHist,
    uptimeStr, ctrRunning, ctrStopped, ctrError,
    toggleCols, removeWidget, addWidget,
  }
}
