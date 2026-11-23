<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Line } from 'vue-chartjs'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler } from 'chart.js'
import { Card } from '@/components/ui/card'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import { trpc } from '../../lib/trpc'
import { useAppearance } from '../../lib/theme'
import { resolveThemeColor, withAlpha } from '../../lib/theme-colors'
import { fmtRate, niceBytes } from '../../lib/perf-math'
import { formatBytes } from '../../lib/file-details'
import { dateFormat } from '../../lib/intl-cache'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

const { t } = useI18n()
const { appearance } = useAppearance()

type Period = '1h' | '6h' | '24h' | '7d'
const PERIODS: Period[] = ['1h', '6h', '24h', '7d']
const period = ref<Period>('24h')
type Snapshot = Awaited<ReturnType<typeof trpc.system.metricsHistory.query>>[number]
const data = ref<Snapshot[]>([])
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await trpc.system.metricsHistory.query({ period: period.value })
  } catch (e) {
    error.value = (e as Error).message || t('monitor.history.failed')
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(period, load)

function readColors() {
  return {
    cpu: resolveThemeColor('--color-primary'),
    mem: resolveThemeColor('--color-secondary'),
    net: resolveThemeColor('--color-warning'),
    text: resolveThemeColor('--color-base-content'),
    surface: resolveThemeColor('--color-base-100'),
    border: resolveThemeColor('--color-base-300'),
  }
}
const colors = ref(readColors())
watch(appearance, () => { void nextTick(() => { colors.value = readColors() }) }, { deep: true })
const darkQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
const onScheme = () => { void nextTick(() => { colors.value = readColors() }) }
darkQuery?.addEventListener('change', onScheme)
onUnmounted(() => darkQuery?.removeEventListener('change', onScheme))

const labels = computed(() => data.value.map(s => {
  const d = new Date(s.timestamp)
  return period.value === '7d'
    ? dateFormat(undefined, { weekday: 'short', day: 'numeric' }).format(d) + ' ' + dateFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d)
    : dateFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d)
}))

const dataset = (values: number[], color: string, dashed = false) => ({
  data: values, borderColor: color, backgroundColor: withAlpha(color, dashed ? 0 : 0.14),
  borderWidth: 1.5, borderDash: dashed ? [4, 3] : [], pointRadius: 0, pointHitRadius: 6, tension: 0.25, fill: !dashed,
})

const stats = (values: number[]) => ({
  avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
  peak: values.length ? Math.max(...values) : 0,
})

const charts = computed(() => {
  const d = data.value
  const cpu = d.map(s => s.cpuPct)
  const mem = d.map(s => s.ramTotal ? (s.ramUsed / s.ramTotal) * 100 : 0)
  const rx = d.map(s => s.netRxBps)
  const tx = d.map(s => s.netTxBps)
  const pct = (v: number) => `${Math.round(v)} %`
  const memLast = d[d.length - 1]
  return [
    { id: 'cpu', title: 'CPU', unit: pct, stats: [stats(cpu)], datasets: [dataset(cpu, colors.value.cpu)], max: 100,
      legend: [] as string[], parts: [] as string[] },
    { id: 'mem', title: t('monitor.perf.memory'), unit: pct, stats: [stats(mem)], datasets: [dataset(mem, colors.value.mem)], max: 100,
      legend: memLast ? [t('monitor.history.ofTotal', { total: formatBytes(memLast.ramTotal) })] : [], parts: [] as string[] },
    { id: 'net', title: t('monitor.history.network'), unit: fmtRate, stats: [stats(rx), stats(tx)],
      datasets: [dataset(rx, colors.value.net), dataset(tx, colors.value.net, true)], max: niceBytes([...rx, ...tx]),
      legend: [] as string[], parts: [t('monitor.perf.receive'), t('monitor.perf.send')] },
  ]
})

function options(unit: (v: number) => string, max?: number) {
  const grid = { color: withAlpha(colors.value.text, 0.08) }
  const ticks = { color: withAlpha(colors.value.text, 0.7), font: { size: 10 } }
  return {
    responsive: true, maintainAspectRatio: false, animation: false as const,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: colors.value.surface, titleColor: colors.value.text, bodyColor: colors.value.text,
        borderColor: colors.value.border, borderWidth: 1,
        callbacks: { label: (c: { parsed: { y: number | null } }) => unit(c.parsed.y ?? 0) },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { ...ticks, maxTicksLimit: 7, maxRotation: 0 } },
      y: { grid, ticks: { ...ticks, maxTicksLimit: 5, ...(max ? { stepSize: max / 4 } : {}), callback: (v: string | number) => unit(Number(v)) }, beginAtZero: true, ...(max ? { max } : {}) },
    },
  }
}
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold text-base-content">{{ t('monitor.history.title') }}</h2>
        <p class="text-sm text-base-content/70">{{ t('monitor.history.subtitle') }}</p>
      </div>
      <ToggleGroup type="single" variant="tabs" size="sm" :model-value="period" :aria-label="t('monitor.history.period')"
        @update:model-value="v => { if (typeof v === 'string' && v) period = v as Period }">
        <ToggleGroupItem v-for="p in PERIODS" :key="p" :value="p">{{ t(`monitor.history.p${p}`) }}</ToggleGroupItem>
      </ToggleGroup>
    </div>

    <LoadingState v-if="loading && !data.length" variant="block" />
    <ErrorState v-else-if="error" :message="error" :retry-label="t('common.retry')" @retry="load" />
    <p v-else-if="!data.length" class="rounded-box border border-dashed border-base-300 px-4 py-12 text-center text-sm text-base-content/70">
      {{ t('monitor.history.empty') }}
    </p>
    <div v-else class="space-y-4" :class="loading && 'opacity-60 transition-opacity'">
      <Card v-for="c in charts" :key="c.id" class="gap-3 p-4 @2xl:p-5">
        <header class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h3 class="text-sm font-semibold text-base-content">{{ c.title }}
            <span v-for="l in c.legend" :key="l" class="ml-2 text-xs font-normal text-base-content/70">{{ l }}</span>
          </h3>
          <dl class="flex flex-wrap gap-x-5 text-xs text-base-content/70">
            <div v-for="(s, i) in c.stats" :key="i" class="flex gap-x-3">
              <span v-if="c.parts[i]" class="flex items-center gap-1.5 text-base-content/90">
                <span v-if="i === 0" class="h-0.5 w-4" :style="{ backgroundColor: colors.net }" aria-hidden="true" />
                <span v-else class="w-4 border-t-2 border-dashed" :style="{ borderColor: colors.net }" aria-hidden="true" />{{ c.parts[i] }}</span>
              <div class="flex gap-1"><dt>{{ t('monitor.history.avg') }}</dt><dd class="tabular-nums text-base-content">{{ c.unit(s.avg) }}</dd></div>
              <div class="flex gap-1"><dt>{{ t('monitor.history.peak') }}</dt><dd class="tabular-nums text-base-content">{{ c.unit(s.peak) }}</dd></div>
            </div>
          </dl>
        </header>
        <div class="h-44">
          <Line :data="{ labels, datasets: c.datasets }" :options="options(c.unit, c.max)" />
        </div>
      </Card>
    </div>
  </section>
</template>
