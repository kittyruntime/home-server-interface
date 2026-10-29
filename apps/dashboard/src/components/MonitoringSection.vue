<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Card } from '@/components/ui/card'
import { ChevronDownIcon, ChevronUpIcon, LayersIcon, LayoutTemplateIcon, WifiIcon } from '@lucide/vue'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Tooltip, Filler,
} from 'chart.js'
import { trpc } from '../lib/trpc'
import LoadingState from './ui/LoadingState.vue'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import ErrorState from './ui/ErrorState.vue'

const { t } = useI18n()

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

type Sysinfo = { loadavg: [number, number, number] }
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
    error.value = e?.message ?? t('uis.settings.MonitoringSection.failedToLoadMetrics')
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

// ── History tab ───────────────────────────────────────────────────────────────

type Period = '1h' | '6h' | '24h' | '7d'
const viewMode = ref<'live' | 'history'>('live')
const period   = ref<Period>('1h')

type Snapshot = { timestamp: string | Date; cpuPct: number; ramUsed: number; ramTotal: number; netRxBps: number; netTxBps: number }
const historyData    = ref<Snapshot[]>([])
const historyLoading = ref(false)
const historyError   = ref('')

async function loadHistory() {
  historyLoading.value = true
  historyError.value   = ''
  try {
    historyData.value = await trpc.system.metricsHistory.query({ period: period.value })
  } catch (e: unknown) {
    // Distinguish a failed fetch from the genuine "no data recorded yet" case
    // below, which otherwise looks identical to the user.
    historyError.value = (e as { message?: string })?.message ?? t('uis.settings.MonitoringSection.failedToLoadMetricsHistory')
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
    <h2 class="text-lg font-semibold text-foreground mb-1">{{ t('ui.monitor.MonitoringSection.monitoring') }}</h2>
    <p class="text-sm text-muted-foreground mb-6">{{ t('ui.monitor.MonitoringSection.liveUsageNowAndHistory') }}</p>

    <!-- View toggle -->
    <Tabs
      :model-value="viewMode"
      class="mb-6"
      @update:model-value="v => { if (v === 'history') { viewMode = 'history'; loadHistory() } else viewMode = 'live' }"
    >
      <TabsList>
        <TabsTrigger value="live">{{ t('ui.monitor.MonitoringSection.live') }}</TabsTrigger>
        <TabsTrigger value="history">{{ t('ui.monitor.MonitoringSection.history') }}</TabsTrigger>
      </TabsList>
    </Tabs>

    <LoadingState v-if="loading" variant="block" />
    <Alert variant="destructive" v-else-if="error" class="mt-4"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <div v-else-if="viewMode === 'live'">
      <template v-if="sysinfo && metrics">
        <div class="space-y-4">

          <!-- ── Processor ────────────────────────────────────────────────── -->
          <Card class="block gap-0 py-0 shadow-none overflow-hidden">
            <div class="px-4 py-3 flex items-center gap-2 border-b border-border">
              <LayoutTemplateIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
              <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.monitor.MonitoringSection.processor') }}</span>
            </div>

            <div class="px-4 py-4 space-y-4">
              <!-- Usage bar -->
              <div class="space-y-1.5">
                <div class="flex justify-between text-xs text-muted-foreground">
                  <span>{{ t('ui.monitor.MonitoringSection.usage') }}</span>
                  <span class="font-medium tabular-nums"
                    :class="metrics.cpu > 80 ? 'text-destructive' : metrics.cpu > 60 ? 'text-warning' : 'text-foreground'"
                  >{{ metrics.cpu }}%</span>
                </div>
                <Progress class="w-full h-1.5 bg-muted rounded-full" :model-value="metrics.cpu" :indicator-class="['rounded-full transition-all duration-700', metrics.cpu > 80 ? 'bg-destructive' : metrics.cpu > 60 ? 'bg-warning' : 'bg-primary']" />
              </div>

              <!-- Load averages -->
              <div class="flex items-center gap-4">
                <span class="text-xs text-muted-foreground">{{ t('ui.monitor.MonitoringSection.loadAvg') }}</span>
                <div class="flex gap-4">
                  <div v-for="(val, i) in sysinfo.loadavg" :key="i" class="text-center">
                    <div class="text-sm font-medium text-foreground tabular-nums">{{ val.toFixed(2) }}</div>
                    <div class="text-2xs text-muted-foreground">{{ ['1m', '5m', '15m'][i] }}</div>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <!-- ── Memory ────────────────────────────────────────────────────── -->
          <Card class="block gap-0 py-0 shadow-none overflow-hidden">
            <div class="px-4 py-3 flex items-center gap-2 border-b border-border">
              <LayersIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
              <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.monitor.MonitoringSection.memory') }}</span>
            </div>

            <div class="px-4 py-4 space-y-3">
              <div class="flex justify-between items-baseline">
                <span class="text-sm text-foreground/80">
                  {{ fmtBytes(metrics.memory.used) }} used
                </span>
                <span class="text-xs text-muted-foreground">
                  {{ fmtBytes(metrics.memory.total) }} total
                </span>
              </div>
              <Progress class="w-full h-2 bg-muted rounded-full" :model-value="metrics.memory.percent" :indicator-class="['rounded-full transition-all duration-700', metrics.memory.percent > 90 ? 'bg-destructive' : metrics.memory.percent > 75 ? 'bg-warning' : 'bg-primary']" />
              <div class="flex justify-between text-2xs text-muted-foreground">
                <span>{{ fmtBytes(metrics.memory.total - metrics.memory.used) }} free</span>
                <span
                  class="font-medium tabular-nums"
                  :class="metrics.memory.percent > 90 ? 'text-destructive' : metrics.memory.percent > 75 ? 'text-warning' : ''"
                >{{ metrics.memory.percent }}%</span>
              </div>
            </div>
          </Card>

          <!-- ── Network ───────────────────────────────────────────────────── -->
          <Card class="block gap-0 py-0 shadow-none overflow-hidden">
            <div class="px-4 py-3 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <WifiIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.monitor.MonitoringSection.networkThroughput') }}</span>
              </div>
              <div class="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
                <span class="flex items-center gap-1">
                  <ChevronDownIcon class="w-3 h-3 text-success" aria-hidden="true" />
                  {{ fmtBytes(metrics.network.rx) }}/s
                </span>
                <span class="flex items-center gap-1">
                  <ChevronUpIcon class="w-3 h-3 text-info" aria-hidden="true" />
                  {{ fmtBytes(metrics.network.tx) }}/s
                </span>
              </div>
            </div>
          </Card>

        </div>
      </template>
    </div>

    <div v-else-if="viewMode === 'history'">
      <!-- Period selector -->
      <ToggleGroup
        type="single" variant="outline" size="sm"
        class="mb-5"
        :model-value="period"
        :aria-label="t('ui.monitor.MonitoringSection.historyPeriod')"
        @update:model-value="v => { if (typeof v === 'string' && v) { period = v as Period; loadHistory() } }"
      >
        <ToggleGroupItem v-for="p in (['1h','6h','24h','7d'] as const)" :key="p" :value="p" class="px-3 text-xs">{{ p }}</ToggleGroupItem>
      </ToggleGroup>

      <LoadingState v-if="historyLoading" />
      <ErrorState v-else-if="historyError" :message="historyError" :retry-label="t('ui.monitor.MonitoringSection.retry')" @retry="loadHistory" />
      <div v-else-if="!historyData.length" class="text-center py-12 text-sm text-muted-foreground">
        {{ t('ui.monitor.MonitoringSection.noDataYetHistoryIs') }}
      </div>
      <template v-else>
        <!-- CPU chart -->
        <div class="mb-6">
          <div class="eyebrow mb-2">{{ t('ui.monitor.MonitoringSection.cpu') }}</div>
          <Card class="block gap-0 py-0 shadow-none h-32 rounded-lg p-3">
            <Line :data="cpuChartData" :options="chartOptions" />
          </Card>
        </div>
        <!-- RAM chart -->
        <div class="mb-6">
          <div class="eyebrow mb-2">{{ t('ui.monitor.MonitoringSection.ramGb') }}</div>
          <Card class="block gap-0 py-0 shadow-none h-32 rounded-lg p-3">
            <Line :data="ramChartData" :options="chartOptions" />
          </Card>
        </div>
        <!-- Network chart -->
        <div class="mb-6">
          <div class="eyebrow mb-2">{{ t('ui.monitor.MonitoringSection.networkMbS') }}</div>
          <Card class="block gap-0 py-0 shadow-none h-32 rounded-lg p-3">
            <Line :data="netChartData" :options="chartOptions" />
          </Card>
        </div>
      </template>
    </div>
  </div>
</template>
