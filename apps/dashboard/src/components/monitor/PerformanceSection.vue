<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { CpuIcon, HardDriveIcon, MemoryStickIcon, NetworkIcon } from '@lucide/vue'
import { Card } from '@/components/ui/card'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import PerfGauge from './perf/PerfGauge.vue'
import PerfCpu from './perf/PerfCpu.vue'
import PerfMemory from './perf/PerfMemory.vue'
import PerfDisks from './perf/PerfDisks.vue'
import PerfNetworks from './perf/PerfNetworks.vue'
import OwnerBoard from './rank/OwnerBoard.vue'
import { perf, perfError, subscribePerf, RESOURCE_COLOR } from '../../lib/perf-live'
import { fmtRate, fmtUptime } from '../../lib/perf-math'
import { formatBytes } from '../../lib/file-details'
import { trpc } from '../../lib/trpc'

const emit = defineEmits<{ openProcesses: [key: string | null] }>()
const { t } = useI18n()

let stop: (() => void) | null = null
const host = ref<{ hostname: string; release: string; arch: string } | null>(null)
onMounted(async () => {
  stop = subscribePerf()
  try { host.value = await trpc.system.sysinfo.query() } catch { /* the header just stays shorter */ }
})
onUnmounted(() => stop?.())

type GaugeId = 'cpu' | 'mem' | 'disk' | 'net'
interface Gauge { id: GaugeId; icon: Component; label: string; value: string; sub: string; level: number | null; color: string; flow?: { rx: string; tx: string } }

const selected = ref<GaugeId>('cpu')

const gauges = computed<Gauge[]>(() => {
  const p = perf.value
  if (!p) return []
  const memPct = p.memory.total ? (p.memory.used / p.memory.total) * 100 : 0
  const disk = p.disks.reduce((a, d) => ({ r: a.r + d.readBps, w: a.w + d.writeBps, busy: Math.max(a.busy, d.busy) }), { r: 0, w: 0, busy: 0 })
  const net = p.nets.reduce((a, n) => ({ rx: a.rx + n.rxBps, tx: a.tx + n.txBps, cap: a.cap + (n.up ? n.speedMbps ?? 0 : 0) }), { rx: 0, tx: 0, cap: 0 })
  // A link's speed is per direction: the busier direction against the links' total.
  const netLevel = net.cap ? (Math.max(net.rx, net.tx) * 8 / (net.cap * 1_000_000)) * 100 : null
  return [
    { id: 'cpu', icon: CpuIcon, label: 'CPU', value: `${Math.round(p.cpu.usage)} %`, sub: t('monitor.perf.coresAt', { n: p.cpu.cores }, p.cpu.cores), level: p.cpu.usage, color: RESOURCE_COLOR.cpu },
    { id: 'mem', icon: MemoryStickIcon, label: t('monitor.perf.memory'), value: `${Math.round(memPct)} %`,
      sub: t('monitor.perf.memOf', { used: formatBytes(p.memory.used), total: formatBytes(p.memory.total) }), level: memPct, color: RESOURCE_COLOR.mem },
    { id: 'disk', icon: HardDriveIcon, label: t('monitor.perf.disks'), value: fmtRate(disk.r + disk.w),
      sub: t('monitor.perf.busiest', { pct: Math.round(disk.busy) }), level: disk.busy, color: RESOURCE_COLOR.disk },
    { id: 'net', icon: NetworkIcon, label: t('monitor.perf.networkAll'), value: fmtRate(net.rx + net.tx),
      sub: t('monitor.perf.rxTx', { rx: fmtRate(net.rx), tx: fmtRate(net.tx) }), flow: { rx: fmtRate(net.rx), tx: fmtRate(net.tx) }, level: netLevel, color: RESOURCE_COLOR.net },
  ]
})
const current = computed(() => gauges.value.find(g => g.id === selected.value))
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
      <div>
        <h2 class="text-lg font-semibold text-base-content">{{ t('monitor.perf.title') }}</h2>
        <p class="text-sm text-base-content/70">{{ t('monitor.perf.subtitle') }}</p>
      </div>
      <p v-if="perf" class="flex flex-wrap gap-x-4 text-xs text-base-content/70">
        <span v-if="host"><span class="font-mono text-base-content/90">{{ host.hostname }}</span> · Linux {{ host.release }} ({{ host.arch }})</span>
        <span>{{ t('monitor.perf.uptime') }} <span class="tabular-nums text-base-content/90">{{ fmtUptime(perf.uptime) }}</span></span>
      </p>
    </div>

    <LoadingState v-if="!perf && !perfError" variant="block" />
    <ErrorState v-else-if="!perf && perfError" :message="t('monitor.perf.failed')" />

    <template v-else-if="perf">
      <!-- One instrument panel: the four readings, and under them the detail of the one picked. -->
      <Card class="@container gap-0 overflow-hidden p-0">
        <div class="grid grid-cols-2 divide-base-300/70 @3xl:grid-cols-4 @3xl:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-base-300/70 @3xl:[&>*:nth-child(-n+2)]:border-b-0 [&>*:nth-child(odd)]:border-r [&>*:nth-child(odd)]:border-base-300/70 @3xl:[&>*:nth-child(odd)]:border-r-0"
          role="group" :aria-label="t('monitor.perf.resources')">
          <PerfGauge v-for="g in gauges" :key="g.id" :icon="g.icon" :label="g.label" :value="g.value" :sub="g.sub" :flow="g.flow" :level="g.level"
            :color="g.color" :selected="g.id === selected" controls="perf-detail" @select="selected = g.id" />
        </div>
        <div id="perf-detail" class="border-t border-base-300/70 p-4 @2xl:p-5" role="region" :aria-label="current?.label">
          <PerfCpu v-if="selected === 'cpu'" :perf="perf" />
          <PerfMemory v-else-if="selected === 'mem'" :perf="perf" />
          <PerfDisks v-else-if="selected === 'disk'" :disks="perf.disks" />
          <PerfNetworks v-else :nets="perf.nets" />
        </div>
      </Card>

      <OwnerBoard @open="key => emit('openProcesses', key)" />
    </template>
  </section>
</template>
