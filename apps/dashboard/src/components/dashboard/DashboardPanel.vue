<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, type Ref } from 'vue'
import { trpc } from '../../lib/trpc'

// ---- Types ----------------------------------------------------------------

type WidgetType = 'cpu' | 'memory' | 'network' | 'containers'
interface Widget { id: string; type: WidgetType; cols: 1 | 2 }

interface Metrics {
  cpu:     number
  memory:  { total: number; used: number; percent: number }
  network: { rx: number; tx: number }
  uptime:  number
}

type ContainerStatus = { status: string }

// ---- Widget catalog -------------------------------------------------------

const CATALOG: { type: WidgetType; label: string }[] = [
  { type: 'cpu',        label: 'CPU'        },
  { type: 'memory',     label: 'Memory'     },
  { type: 'network',    label: 'Network'    },
  { type: 'containers', label: 'Containers' },
]

// ---- Persistence ----------------------------------------------------------

const SK = 'brume:dashboard'

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

// ---- State ----------------------------------------------------------------

const widgets   = ref<Widget[]>(loadWidgets())
const metrics   = ref<Metrics | null>(null)
const containers = ref<ContainerStatus[]>([])
const addOpen   = ref(false)

// history (30 pts)
const HIST = 30
const cpuHist = ref<number[]>([])
const rxHist  = ref<number[]>([])
const txHist  = ref<number[]>([])

function pushHist(arr: Ref<number[]>, val: number) {
  arr.value.push(val)
  if (arr.value.length > HIST) arr.value.shift()
}

// ---- Polling --------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null

async function fetchMetrics() {
  try {
    const m = await trpc.system.metrics.query()
    metrics.value = m as Metrics
    pushHist(cpuHist, m.cpu)
    pushHist(rxHist,  m.network.rx)
    pushHist(txHist,  m.network.tx)
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

// ---- Uptime format --------------------------------------------------------

const uptimeStr = computed(() => {
  const s = metrics.value?.uptime ?? 0
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `up ${d}d ${h}h`
  if (h > 0) return `up ${h}h ${m}m`
  return `up ${m}m`
})

// ---- Byte formatting ------------------------------------------------------

function fmtBytes(b: number): string {
  if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + ' MB/s'
  if (b >= 1024)      return (b / 1024).toFixed(1) + ' KB/s'
  return b + ' B/s'
}

function fmtMem(b: number): string {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + ' GB'
  if (b >= 1_048_576)     return (b / 1_048_576).toFixed(0) + ' MB'
  return (b / 1024).toFixed(0) + ' KB'
}

// ---- Container counters ---------------------------------------------------

const ctrRunning = computed(() => containers.value.filter(c => c.status === 'running').length)
const ctrStopped = computed(() => containers.value.filter(c => c.status === 'stopped').length)
const ctrError   = computed(() => containers.value.filter(c => c.status === 'error').length)

// ---- Sparkline ------------------------------------------------------------

function spark(
  vals: number[],
  lo = 0,
  hi?: number,
): { line: string; area: string } {
  if (vals.length < 2) return { line: '', area: '' }
  const max = hi ?? Math.max(...vals, 1)
  const min = lo
  const W = 100
  const H = 40
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W
    const y = H - ((v - min) / (max - min || 1)) * H
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = `M${pts.join('L')}`
  const area = `${line}L${W},${H}L0,${H}Z`
  return { line, area }
}

// ---- Widget controls -------------------------------------------------------

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
  addOpen.value = false
}

// Close add dropdown on outside click
function onDocClick() { addOpen.value = false }
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div class="flex flex-col h-full">

    <!-- Toolbar -->
    <div class="flex items-center justify-between px-6 py-4 border-b border-[var(--c-border)] flex-shrink-0">
      <div class="flex items-center gap-3">
        <h3 class="text-sm font-semibold text-[var(--c-text-1)]">Overview</h3>
        <span v-if="metrics" class="text-xs text-slate-600 font-mono">{{ uptimeStr }}</span>
      </div>

      <!-- Add widget dropdown -->
      <div class="relative">
        <button
          @click.stop="addOpen = !addOpen"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 border border-[var(--c-border-strong)] text-[var(--c-text-2)] text-sm rounded-lg hover:bg-[var(--c-hover)] transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Add
        </button>

        <Transition name="dropdown">
          <div
            v-if="addOpen"
            class="absolute right-0 top-full mt-1.5 bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl shadow-2xl overflow-hidden z-20 min-w-[140px]"
          >
            <button
              v-for="cat in CATALOG"
              :key="cat.type"
              @click.stop="addWidget(cat.type)"
              class="w-full text-left px-4 py-2.5 text-sm text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors"
            >
              {{ cat.label }}
            </button>
          </div>
        </Transition>
      </div>
    </div>

    <!-- Widget grid -->
    <div class="flex-1 overflow-y-auto p-6">
      <div v-if="widgets.length === 0" class="flex flex-col items-center justify-center h-full gap-3 text-slate-600">
        <svg class="w-10 h-10 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/>
        </svg>
        <p class="text-sm">No widgets. Click <strong class="text-slate-400">Add</strong> to get started.</p>
      </div>

      <div class="grid grid-cols-3 gap-4">
        <div
          v-for="w in widgets" :key="w.id"
          :class="['relative group/card bg-[var(--c-surface-alt)] border border-[var(--c-border)] rounded-2xl p-5 min-h-[130px] flex flex-col', w.cols === 2 ? 'col-span-2' : 'col-span-1']"
        >
          <!-- Widget controls -->
          <div class="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity">
            <button
              @click="toggleCols(w)"
              :title="w.cols === 1 ? 'Expand' : 'Shrink'"
              class="w-6 h-6 flex items-center justify-center text-slate-600 hover:text-[var(--c-text-2)] hover:bg-[var(--c-hover)] rounded-md transition-colors text-xs"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 9l4-4 4 4M8 15l4 4 4-4" v-if="w.cols === 1"/>
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 8l-4 4 4 4M15 8l4 4-4 4" v-else/>
              </svg>
            </button>
            <button
              @click="removeWidget(w.id)"
              title="Remove"
              class="w-6 h-6 flex items-center justify-center text-slate-600 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

          <!-- ---- CPU ---- -->
          <template v-if="w.type === 'cpu'">
            <p class="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-3">CPU</p>
            <div class="flex items-end gap-4 flex-1">
              <div class="flex-shrink-0">
                <span class="text-4xl font-bold text-[var(--c-text-3)] tabular-nums leading-none">
                  {{ metrics?.cpu ?? '—' }}
                </span>
                <span class="text-lg text-slate-500 ml-0.5">%</span>
              </div>
              <div class="flex-1 min-w-0">
                <svg
                  v-if="cpuHist.length >= 2"
                  viewBox="0 0 100 40"
                  preserveAspectRatio="none"
                  class="w-full h-10"
                >
                  <defs>
                    <linearGradient id="cpu-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="var(--c-accent)" stop-opacity="0.25"/>
                      <stop offset="100%" stop-color="var(--c-accent)" stop-opacity="0"/>
                    </linearGradient>
                  </defs>
                  <path :d="spark(cpuHist, 0, 100).area" fill="url(#cpu-grad)"/>
                  <path :d="spark(cpuHist, 0, 100).line" fill="none" stroke="var(--c-accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
                </svg>
              </div>
            </div>
          </template>

          <!-- ---- Memory ---- -->
          <template v-else-if="w.type === 'memory'">
            <p class="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-3">Memory</p>
            <div class="flex-1 flex flex-col justify-between">
              <div class="flex items-baseline justify-between mb-3">
                <span class="text-2xl font-bold text-[var(--c-text-3)] tabular-nums leading-none">
                  {{ metrics ? fmtMem(metrics.memory.used) : '—' }}
                </span>
                <span class="text-xs text-slate-500">
                  of {{ metrics ? fmtMem(metrics.memory.total) : '—' }}
                </span>
              </div>
              <div class="space-y-1.5">
                <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-500"
                    :class="(metrics?.memory.percent ?? 0) > 85 ? 'bg-red-500' : (metrics?.memory.percent ?? 0) > 65 ? 'bg-amber-400' : 'bg-emerald-500'"
                    :style="{ width: (metrics?.memory.percent ?? 0) + '%' }"
                  />
                </div>
                <p class="text-xs text-slate-500 tabular-nums">{{ metrics?.memory.percent ?? 0 }}% used</p>
              </div>
            </div>
          </template>

          <!-- ---- Network ---- -->
          <template v-else-if="w.type === 'network'">
            <p class="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-3">Network</p>
            <div class="flex-1 flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <div class="space-y-0.5">
                  <div class="flex items-center gap-1.5">
                    <span class="text-[10px] font-semibold text-emerald-500 uppercase tracking-widest">↓ rx</span>
                    <span class="text-sm font-mono text-[var(--c-text-1)]">{{ metrics ? fmtBytes(metrics.network.rx) : '—' }}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="text-[10px] font-semibold text-[var(--c-accent)] uppercase tracking-widest">↑ tx</span>
                    <span class="text-sm font-mono text-[var(--c-text-1)]">{{ metrics ? fmtBytes(metrics.network.tx) : '—' }}</span>
                  </div>
                </div>
                <div class="flex-1 min-w-0 ml-4">
                  <svg
                    v-if="rxHist.length >= 2 || txHist.length >= 2"
                    viewBox="0 0 100 40"
                    preserveAspectRatio="none"
                    class="w-full h-10"
                  >
                    <defs>
                      <linearGradient id="rx-grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="#10b981" stop-opacity="0.2"/>
                        <stop offset="100%" stop-color="#10b981" stop-opacity="0"/>
                      </linearGradient>
                    </defs>
                    <path
                      v-if="rxHist.length >= 2"
                      :d="spark(rxHist).area"
                      fill="url(#rx-grad)"
                    />
                    <path
                      v-if="rxHist.length >= 2"
                      :d="spark(rxHist).line"
                      fill="none" stroke="#10b981" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
                    />
                    <path
                      v-if="txHist.length >= 2"
                      :d="spark(txHist).line"
                      fill="none" stroke="var(--c-accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
                    />
                  </svg>
                </div>
              </div>
            </div>
          </template>

          <!-- ---- Containers ---- -->
          <template v-else-if="w.type === 'containers'">
            <p class="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-3">Containers</p>
            <div class="flex-1 flex items-center gap-6">
              <div class="text-center">
                <p class="text-3xl font-bold text-emerald-400 tabular-nums leading-none">{{ ctrRunning }}</p>
                <p class="text-[10px] text-slate-500 uppercase tracking-widest mt-1">Running</p>
              </div>
              <div class="text-center">
                <p class="text-3xl font-bold text-slate-500 tabular-nums leading-none">{{ ctrStopped }}</p>
                <p class="text-[10px] text-slate-500 uppercase tracking-widest mt-1">Stopped</p>
              </div>
              <div class="text-center">
                <p class="text-3xl font-bold tabular-nums leading-none" :class="ctrError > 0 ? 'text-red-400' : 'text-slate-700'">{{ ctrError }}</p>
                <p class="text-[10px] text-slate-500 uppercase tracking-widest mt-1">Error</p>
              </div>
            </div>
          </template>

        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
