<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import PerfTile from './perf/PerfTile.vue'
import PerfCpu from './perf/PerfCpu.vue'
import PerfMemory from './perf/PerfMemory.vue'
import PerfDisk from './perf/PerfDisk.vue'
import PerfNetwork from './perf/PerfNetwork.vue'
import { curve, perf, perfError, subscribePerf, RESOURCE_COLOR } from '../../lib/perf-live'
import { fmtRate, fmtUptime, niceBytes } from '../../lib/perf-math'
import { formatBytes } from '../../lib/file-details'
import { trpc } from '../../lib/trpc'

const { t } = useI18n()

let stop: (() => void) | null = null
const host = ref<{ hostname: string; release: string; arch: string } | null>(null)
onMounted(async () => {
  stop = subscribePerf()
  try { host.value = await trpc.system.sysinfo.query() } catch { /* the header just stays shorter */ }
})
onUnmounted(() => stop?.())

interface Resource { id: string; title: string; heading: string; value: string; sub?: string; values: number[]; max: number; color: string }

const resources = computed<Resource[]>(() => {
  const p = perf.value
  if (!p) return []
  const memPct = p.memory.total ? Math.round((p.memory.used / p.memory.total) * 100) : 0
  const out: Resource[] = [
    { id: 'cpu', title: 'CPU', heading: 'CPU', value: `${Math.round(p.cpu.usage)} %`, sub: p.cpu.model, values: curve('cpu'), max: 100, color: RESOURCE_COLOR.cpu },
    { id: 'mem', title: t('monitor.perf.memory'), heading: t('monitor.perf.memory'), value: `${formatBytes(p.memory.used)} / ${formatBytes(p.memory.total)} (${memPct} %)`, values: curve('mem'), max: 100, color: RESOURCE_COLOR.mem },
  ]
  p.disks.forEach((d, i) => out.push({
    id: `disk:${d.name}`, title: t('monitor.perf.disk', { n: i, name: d.name }), heading: t('monitor.perf.disk', { n: i, name: d.name }),
    value: `${Math.round(d.busy)} %`, sub: [d.rotational ? t('monitor.perf.hdd') : t('monitor.perf.ssd'), d.model].filter(Boolean).join(' · '),
    values: curve(`disk:${d.name}:busy`), max: 100, color: RESOURCE_COLOR.disk,
  }))
  for (const n of p.nets) {
    const values = curve(`net:${n.name}:rx`).map((v, i) => v + (curve(`net:${n.name}:tx`)[i] ?? 0))
    out.push({
      id: `net:${n.name}`, title: n.name, heading: t('monitor.perf.network', { name: n.name }),
      value: n.up ? `↓ ${fmtRate(n.rxBps)}  ↑ ${fmtRate(n.txBps)}` : t('monitor.perf.down'),
      sub: n.addrs.find(a => a.family === 'IPv4')?.addr, values, max: niceBytes(values), color: RESOURCE_COLOR.net,
    })
  }
  return out
})

const selected = ref('cpu')
// A disk or port that disappears falls back to the CPU.
watch(resources, list => { if (list.length && !list.some(r => r.id === selected.value)) selected.value = 'cpu' })
const current = computed(() => resources.value.find(r => r.id === selected.value) ?? resources.value[0])
const disk = computed(() => perf.value?.disks.find(d => `disk:${d.name}` === selected.value))
const net = computed(() => perf.value?.nets.find(n => `net:${n.name}` === selected.value))
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

    <div v-else-if="perf && current" class="grid items-start gap-4 @3xl:grid-cols-[16rem_minmax(0,1fr)]">
      <nav :aria-label="t('monitor.perf.resources')"
        class="-mx-1 flex snap-x gap-1 overflow-x-auto px-1 pb-1 @3xl:mx-0 @3xl:flex-col @3xl:overflow-visible @3xl:px-0 @3xl:pb-0">
        <div v-for="r in resources" :key="r.id" class="w-56 shrink-0 snap-start @3xl:w-auto">
          <PerfTile :title="r.title" :value="r.value" :sub="r.sub" :values="r.values" :max="r.max" :color="r.color"
            :selected="r.id === current.id" @select="selected = r.id" />
        </div>
      </nav>

      <Card class="@container gap-0 p-4 @2xl:p-5">
        <header class="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 class="text-xl font-semibold text-base-content">{{ current.heading }}</h3>
          <p v-if="current.sub" class="min-w-0 truncate text-sm text-base-content/70">{{ current.sub }}</p>
        </header>
        <PerfCpu v-if="current.id === 'cpu'" :perf="perf" />
        <PerfMemory v-else-if="current.id === 'mem'" :perf="perf" />
        <PerfDisk v-else-if="disk" :disk="disk" />
        <PerfNetwork v-else-if="net" :net="net" />
      </Card>
    </div>
  </section>
</template>
