<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Tooltip, Filler,
} from 'chart.js'
import { trpc } from '../lib/trpc'
import LoadingSpinner from './ui/LoadingSpinner.vue'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

type Sysinfo = {
  hostname: string; platform: string; arch: string; release: string
  cpuModel: string; cpuCount: number; loadavg: [number, number, number]
  ifaces: Array<{ name: string; addrs: Array<{ addr: string; family: string }> }>
}
type Metrics = {
  cpu: number
  memory: { total: number; used: number; percent: number }
  network: { rx: number; tx: number }
  uptime: number
}

const loading  = ref(true)
const error    = ref('')
const sysinfo  = ref<Sysinfo | null>(null)
const metrics  = ref<Metrics | null>(null)

let timer: ReturnType<typeof setInterval> | null = null

async function fetchMetrics() {
  try { metrics.value = await trpc.system.metrics.query() } catch {}
}

onMounted(async () => {
  try {
    const [s, m] = await Promise.all([
      trpc.system.sysinfo.query(),
      trpc.system.metrics.query(),
    ])
    sysinfo.value  = s
    metrics.value  = m
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load system info'
  } finally {
    loading.value = false
  }
  timer = setInterval(fetchMetrics, 3000)
})

onUnmounted(() => { if (timer) clearInterval(timer) })

function fmtBytes(n: number, decimals = 1): string {
  if (n <= 0)         return '0 B'
  if (n < 1024)       return `${n} B`
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(decimals)} KB`
  if (n < 1024 ** 3)  return `${(n / 1024 ** 2).toFixed(decimals)} MB`
  if (n < 1024 ** 4)  return `${(n / 1024 ** 3).toFixed(decimals)} GB`
  return `${(n / 1024 ** 4).toFixed(decimals)} TB`
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0 || d > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

// ── History tab ───────────────────────────────────────────────────────────────

type Period = '1h' | '6h' | '24h' | '7d'
const viewMode = ref<'live' | 'history'>('live')
const period   = ref<Period>('1h')

type Snapshot = { timestamp: string | Date; cpuPct: number; ramUsed: number; ramTotal: number; netRxBps: number; netTxBps: number }
const historyData    = ref<Snapshot[]>([])
const historyLoading = ref(false)

async function loadHistory() {
  historyLoading.value = true
  try {
    historyData.value = await trpc.system.metricsHistory.query({ period: period.value })
  } finally {
    historyLoading.value = false
  }
}

const chartLabels = computed(() =>
  historyData.value.map(s => {
    const d = new Date(s.timestamp)
    if (period.value === '7d') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  })
)

function lineDataset(label: string, values: number[], color: string) {
  return {
    label,
    data: values,
    borderColor: color,
    backgroundColor: color.replace(')', ', 0.1)').replace('rgb', 'rgba'),
    borderWidth: 1.5,
    pointRadius: 0,
    tension: 0.3,
    fill: true,
  }
}

const cpuChartData = computed(() => ({
  labels: chartLabels.value,
  datasets: [lineDataset('CPU %', historyData.value.map(s => s.cpuPct), 'rgb(215, 25, 33)')],
}))

const ramChartData = computed(() => ({
  labels: chartLabels.value,
  datasets: [lineDataset('RAM GB', historyData.value.map(s => s.ramUsed / 1073741824), 'rgb(59, 130, 246)')],
}))

const netChartData = computed(() => ({
  labels: chartLabels.value,
  datasets: [
    lineDataset('RX MB/s', historyData.value.map(s => s.netRxBps / 1048576), 'rgb(34, 197, 94)'),
    lineDataset('TX MB/s', historyData.value.map(s => s.netTxBps / 1048576), 'rgb(251, 146, 60)'),
  ],
}))

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: { mode: 'index' as const, intersect: false } },
  scales: {
    x: { grid: { color: 'rgba(128,128,128,0.1)' }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
    y: { grid: { color: 'rgba(128,128,128,0.1)' }, ticks: { font: { size: 10 } }, beginAtZero: true },
  },
}
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-[var(--c-text-1)] mb-1">System</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">Hardware and OS information for this host.</p>

    <!-- View toggle -->
    <div class="flex items-center gap-1 mb-6 p-1 rounded-lg bg-[var(--c-surface-deep)] w-fit">
      <button @click="viewMode = 'live'"
        :class="['px-3 py-1.5 text-xs rounded-md transition-colors', viewMode === 'live' ? 'bg-[var(--c-surface)] text-[var(--c-text-1)] shadow-sm' : 'text-[var(--c-text-3)] hover:text-[var(--c-text-2)]']">
        Live
      </button>
      <button @click="viewMode = 'history'; loadHistory()"
        :class="['px-3 py-1.5 text-xs rounded-md transition-colors', viewMode === 'history' ? 'bg-[var(--c-surface)] text-[var(--c-text-1)] shadow-sm' : 'text-[var(--c-text-3)] hover:text-[var(--c-text-2)]']">
        History
      </button>
    </div>

    <div v-if="loading" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm">
      <LoadingSpinner /> Loading…
    </div>
    <div v-else-if="error" class="text-sm text-red-400">{{ error }}</div>

    <div v-else-if="viewMode === 'live'">
      <template v-if="sysinfo && metrics">
        <div class="space-y-4">

          <!-- ── Overview ─────────────────────────────────────────────────── -->
          <div class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] divide-y divide-[var(--c-border)]">
            <div class="px-4 py-3 flex items-center gap-2">
              <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
              </svg>
              <span class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Overview</span>
            </div>

            <dl class="grid grid-cols-2 divide-x divide-[var(--c-border)]">
              <div class="px-4 py-3 space-y-3">
                <div>
                  <dt class="text-[10px] uppercase tracking-wider text-[var(--c-text-3)] mb-0.5">Hostname</dt>
                  <dd class="text-sm font-medium text-[var(--c-text-1)] font-mono">{{ sysinfo.hostname }}</dd>
                </div>
                <div>
                  <dt class="text-[10px] uppercase tracking-wider text-[var(--c-text-3)] mb-0.5">Platform</dt>
                  <dd class="text-sm text-[var(--c-text-2)] capitalize">{{ sysinfo.platform }}</dd>
                </div>
                <div>
                  <dt class="text-[10px] uppercase tracking-wider text-[var(--c-text-3)] mb-0.5">Uptime</dt>
                  <dd class="text-sm text-[var(--c-text-2)] tabular-nums">{{ fmtUptime(metrics.uptime) }}</dd>
                </div>
              </div>
              <div class="px-4 py-3 space-y-3">
                <div>
                  <dt class="text-[10px] uppercase tracking-wider text-[var(--c-text-3)] mb-0.5">Architecture</dt>
                  <dd class="text-sm text-[var(--c-text-2)] font-mono">{{ sysinfo.arch }}</dd>
                </div>
                <div>
                  <dt class="text-[10px] uppercase tracking-wider text-[var(--c-text-3)] mb-0.5">Kernel</dt>
                  <dd class="text-sm text-[var(--c-text-2)] font-mono truncate" :title="sysinfo.release">{{ sysinfo.release }}</dd>
                </div>
              </div>
            </dl>
          </div>

          <!-- ── Processor ────────────────────────────────────────────────── -->
          <div class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] overflow-hidden">
            <div class="px-4 py-3 flex items-center gap-2 border-b border-[var(--c-border)]">
              <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
              </svg>
              <span class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Processor</span>
            </div>

            <div class="px-4 py-4 space-y-4">
              <!-- Model + core count -->
              <div class="flex items-baseline gap-2">
                <span class="text-sm text-[var(--c-text-1)] leading-snug">{{ sysinfo.cpuModel }}</span>
                <span class="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-[var(--c-surface-deep)] text-[var(--c-text-3)] font-mono">×{{ sysinfo.cpuCount }}</span>
              </div>

              <!-- Usage bar -->
              <div class="space-y-1.5">
                <div class="flex justify-between text-xs text-[var(--c-text-3)]">
                  <span>Usage</span>
                  <span class="font-medium tabular-nums"
                    :class="metrics.cpu > 80 ? 'text-red-400' : metrics.cpu > 60 ? 'text-yellow-400' : 'text-[var(--c-text-1)]'"
                  >{{ metrics.cpu }}%</span>
                </div>
                <div class="w-full h-1.5 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-700"
                    :class="metrics.cpu > 80 ? 'bg-red-500' : metrics.cpu > 60 ? 'bg-yellow-500' : 'bg-[var(--c-accent)]'"
                    :style="{ width: metrics.cpu + '%' }"
                  />
                </div>
              </div>

              <!-- Load averages -->
              <div class="flex items-center gap-4">
                <span class="text-xs text-[var(--c-text-3)]">Load avg</span>
                <div class="flex gap-4">
                  <div v-for="(val, i) in sysinfo.loadavg" :key="i" class="text-center">
                    <div class="text-sm font-medium text-[var(--c-text-1)] tabular-nums">{{ val.toFixed(2) }}</div>
                    <div class="text-[10px] text-[var(--c-text-3)]">{{ ['1m', '5m', '15m'][i] }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ── Memory ────────────────────────────────────────────────────── -->
          <div class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] overflow-hidden">
            <div class="px-4 py-3 flex items-center gap-2 border-b border-[var(--c-border)]">
              <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
              </svg>
              <span class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Memory</span>
            </div>

            <div class="px-4 py-4 space-y-3">
              <div class="flex justify-between items-baseline">
                <span class="text-sm text-[var(--c-text-2)]">
                  {{ fmtBytes(metrics.memory.used) }} used
                </span>
                <span class="text-xs text-[var(--c-text-3)]">
                  {{ fmtBytes(metrics.memory.total) }} total
                </span>
              </div>
              <div class="w-full h-2 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-700"
                  :class="metrics.memory.percent > 90 ? 'bg-red-500' : metrics.memory.percent > 75 ? 'bg-yellow-500' : 'bg-[var(--c-accent)]'"
                  :style="{ width: metrics.memory.percent + '%' }"
                />
              </div>
              <div class="flex justify-between text-[11px] text-[var(--c-text-3)]">
                <span>{{ fmtBytes(metrics.memory.total - metrics.memory.used) }} free</span>
                <span
                  class="font-medium tabular-nums"
                  :class="metrics.memory.percent > 90 ? 'text-red-400' : metrics.memory.percent > 75 ? 'text-yellow-400' : ''"
                >{{ metrics.memory.percent }}%</span>
              </div>
            </div>
          </div>

          <!-- ── Network ───────────────────────────────────────────────────── -->
          <div class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] overflow-hidden">
            <div class="px-4 py-3 flex items-center justify-between border-b border-[var(--c-border)]">
              <div class="flex items-center gap-2">
                <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"/>
                </svg>
                <span class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Network</span>
              </div>
              <!-- Live throughput -->
              <div class="flex items-center gap-3 text-xs tabular-nums text-[var(--c-text-3)]">
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
                  </svg>
                  {{ fmtBytes(metrics.network.rx) }}/s
                </span>
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/>
                  </svg>
                  {{ fmtBytes(metrics.network.tx) }}/s
                </span>
              </div>
            </div>

            <div class="divide-y divide-[var(--c-border)]">
              <div
                v-for="iface in sysinfo.ifaces"
                :key="iface.name"
                class="px-4 py-3 flex items-start gap-3"
              >
                <!-- Interface name -->
                <span class="shrink-0 w-12 pt-0.5 font-mono text-xs font-medium text-[var(--c-text-2)]">{{ iface.name }}</span>
                <!-- Addresses -->
                <div class="flex flex-wrap gap-x-4 gap-y-1 flex-1 min-w-0">
                  <span
                    v-for="a in iface.addrs"
                    :key="a.addr"
                    class="font-mono text-xs text-[var(--c-text-2)] flex items-center gap-1.5"
                  >
                    <span
                      class="text-[9px] px-1 py-0.5 rounded border font-sans"
                      :class="a.family === 'IPv6'
                        ? 'text-[var(--c-text-3)] border-[var(--c-border)]'
                        : 'text-[var(--c-accent)] border-[var(--c-accent)]/30 bg-[var(--c-accent-subtle)]'"
                    >{{ a.family === 'IPv6' ? 'v6' : 'v4' }}</span>
                    {{ a.addr }}
                  </span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </template>
    </div>

    <div v-else-if="viewMode === 'history'">
      <!-- Period selector -->
      <div class="flex gap-1 mb-5">
        <button v-for="p in (['1h','6h','24h','7d'] as const)" :key="p"
          @click="period = p; loadHistory()"
          :class="['px-3 py-1 text-xs rounded-lg border transition-colors',
            period === p
              ? 'border-[var(--c-accent)]/50 text-[var(--c-accent)] bg-[var(--c-accent-subtle)]'
              : 'border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-border-strong)]']">
          {{ p }}
        </button>
      </div>

      <div v-if="historyLoading" class="flex justify-center py-12 text-[var(--c-text-3)] text-sm">Loading…</div>
      <div v-else-if="!historyData.length" class="text-center py-12 text-sm text-[var(--c-text-3)]">
        No data yet — history is recorded every minute.
      </div>
      <template v-else>
        <!-- CPU chart -->
        <div class="mb-6">
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-2">CPU %</div>
          <div class="h-32 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
            <Line :data="cpuChartData" :options="chartOptions" />
          </div>
        </div>
        <!-- RAM chart -->
        <div class="mb-6">
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-2">RAM (GB)</div>
          <div class="h-32 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
            <Line :data="ramChartData" :options="chartOptions" />
          </div>
        </div>
        <!-- Network chart -->
        <div class="mb-6">
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-2">Network (MB/s)</div>
          <div class="h-32 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
            <Line :data="netChartData" :options="chartOptions" />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
