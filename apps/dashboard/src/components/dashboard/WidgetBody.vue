<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import SegmentedBar from '../ui/SegmentedBar.vue'
import {
  spark, fmtBytes, fmtMem, memColor, fmtGB, diskColor,
  type DiskFs, type Metrics, type Sysinfo, type Widget,
} from '../../lib/dashboard-widgets'
import { smartStatus, type SmartResult } from '../storage/smart'

// The body of one dashboard widget, shared by the Home panel and the desktop
// widgets: each draws its own card and controls around it.
defineProps<{
  w: Widget
  metrics: Metrics | null
  cpuHist: number[]
  rxHist: number[]
  txHist: number[]
  ctrRunning: number
  ctrStopped: number
  ctrError: number
  disks: DiskFs[]
  sysinfo: Sysinfo | null
  smart: Record<string, SmartResult>
  smartDevices: string[]
}>()

const { t } = useI18n()

const SMART_DOT: Record<string, string> = {
  passed:  'bg-success',
  warning: 'bg-warning',
  failed:  'bg-primary',
  loading: 'bg-base-content/70 animate-pulse',
  unknown: 'bg-base-content/70',
}
</script>

<template>
  <!-- ---- CPU ---- -->
  <template v-if="w.type === 'cpu'">
    <p class="eyebrow mb-3">CPU</p>
    <div class="flex items-end gap-4 flex-1">
      <div class="flex-shrink-0">
        <span
          class="text-4xl font-semibold font-figure tabular-nums leading-none text-base-content"
        >{{ metrics?.cpu ?? '-' }}</span>
        <span class="text-lg text-base-content/70 ml-0.5">%</span>
      </div>
      <div class="flex-1 min-w-0">
        <svg
          v-if="cpuHist.length >= 2"
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
          class="w-full h-10"
        >
          <path :d="spark(cpuHist, 0, 100).line" fill="none" stroke="var(--color-primary)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
      </div>
    </div>
  </template>

  <!-- ---- Memory ---- -->
  <template v-else-if="w.type === 'memory'">
    <p class="eyebrow mb-3">{{ t('ui.home.DashboardPanel.memory') }}</p>
    <div class="flex-1 flex flex-col justify-between">
      <div class="flex items-baseline justify-between mb-3">
        <span class="text-2xl font-bold text-base-content/70 font-figure tabular-nums leading-none">
          {{ metrics ? fmtMem(metrics.memory.used) : '-' }}
        </span>
        <span class="text-xs text-base-content/70">
          of {{ metrics ? fmtMem(metrics.memory.total) : '-' }}
        </span>
      </div>
      <div class="space-y-1.5">
        <SegmentedBar
          :percent="metrics?.memory.percent ?? 0"
          :color="memColor(metrics?.memory.percent ?? 0)"
          height="compact"
        />
        <p class="text-xs text-base-content/70 tabular-nums">{{ t('uip.home.DashboardPanel.used', { p0: metrics?.memory.percent ?? 0 }) }}</p>
      </div>
    </div>
  </template>

  <!-- ---- Network ---- -->
  <template v-else-if="w.type === 'network'">
    <p class="eyebrow mb-3">{{ t('ui.home.DashboardPanel.network') }}</p>
    <div class="flex-1 flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <div class="space-y-0.5">
          <div class="flex items-center gap-1.5">
            <span class="text-2xs font-semibold uppercase tracking-caps text-success">{{ t('ui.home.DashboardPanel.rx') }}</span>
            <span class="text-sm tabular-nums text-base-content">{{ metrics ? fmtBytes(metrics.network.rx) : '-' }}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span class="text-2xs font-semibold text-primary uppercase tracking-caps">{{ t('ui.home.DashboardPanel.tx') }}</span>
            <span class="text-sm tabular-nums text-base-content">{{ metrics ? fmtBytes(metrics.network.tx) : '-' }}</span>
          </div>
        </div>
        <div class="flex-1 min-w-0 ml-4">
          <svg
            v-if="rxHist.length >= 2 || txHist.length >= 2"
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            class="w-full h-10"
          >
            <path
              v-if="rxHist.length >= 2"
              :d="spark(rxHist).line"
              fill="none" stroke="var(--color-success)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
            />
            <path
              v-if="txHist.length >= 2"
              :d="spark(txHist).line"
              fill="none" stroke="var(--color-primary)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
            />
          </svg>
        </div>
      </div>
    </div>
  </template>

  <!-- ---- Containers ---- -->
  <template v-else-if="w.type === 'containers'">
    <p class="eyebrow mb-3">{{ t('ui.home.DashboardPanel.containers') }}</p>
    <div class="flex-1 flex items-center gap-6">
      <div class="text-center">
        <p class="text-3xl font-bold font-figure tabular-nums leading-none text-success">{{ ctrRunning }}</p>
        <p class="text-2xs text-base-content/70 uppercase tracking-caps mt-1">{{ t('ui.home.DashboardPanel.running') }}</p>
      </div>
      <div class="text-center">
        <p class="text-3xl font-bold text-base-content/70 font-figure tabular-nums leading-none">{{ ctrStopped }}</p>
        <p class="text-2xs text-base-content/70 uppercase tracking-caps mt-1">{{ t('ui.home.DashboardPanel.stopped') }}</p>
      </div>
      <div class="text-center">
        <p class="text-3xl font-bold font-figure tabular-nums leading-none" :class="ctrError > 0 ? 'text-primary' : 'text-base-content/70'">{{ ctrError }}</p>
        <p class="text-2xs text-base-content/70 uppercase tracking-caps mt-1">{{ t('ui.home.DashboardPanel.error') }}</p>
      </div>
    </div>
  </template>

  <!-- ---- Storage ---- -->
  <template v-else-if="w.type === 'storage'">
    <p class="eyebrow mb-3">{{ t('ui.home.DashboardPanel.storage') }}</p>
    <div v-if="disks.length === 0" class="flex-1 flex items-center text-xs text-base-content/70">
      {{ t('ui.home.DashboardPanel.noFilesystems') }}
    </div>
    <div v-else class="flex-1 flex flex-col gap-3 overflow-y-auto">
      <div v-for="d in disks" :key="d.mountPoint">
        <div class="flex items-baseline justify-between mb-1 gap-2">
          <span class="text-xs font-mono text-base-content truncate" :title="d.mountPoint">{{ d.mountPoint }}</span>
          <span class="text-2xs text-base-content/70 tabular-nums shrink-0">
            {{ fmtGB(d.used) }} / {{ fmtGB(d.total) }}
          </span>
        </div>
        <SegmentedBar
          :percent="d.total ? Math.round((d.used / d.total) * 100) : 0"
          :color="diskColor(d.total ? (d.used / d.total) * 100 : 0)"
          height="compact"
        />
      </div>
    </div>
  </template>

  <!-- ---- System info ---- -->
  <template v-else-if="w.type === 'sysinfo'">
    <p class="eyebrow mb-3">{{ t('ui.home.DashboardPanel.system') }}</p>
    <div v-if="!sysinfo" class="flex-1 flex items-center text-xs text-base-content/70">-</div>
    <dl v-else class="flex-1 flex flex-col justify-center gap-2 text-sm">
      <div class="flex justify-between gap-3">
        <dt class="text-base-content/70">{{ t('ui.home.DashboardPanel.host') }}</dt>
        <dd class="font-mono text-base-content truncate" :title="sysinfo.hostname">{{ sysinfo.hostname }}</dd>
      </div>
      <div class="flex justify-between gap-3">
        <dt class="text-base-content/70">OS</dt>
        <dd class="text-base-content/80 truncate capitalize" :title="`${sysinfo.platform} ${sysinfo.release}`">{{ sysinfo.platform }} {{ sysinfo.release }}</dd>
      </div>
      <div class="flex justify-between gap-3">
        <dt class="text-base-content/70">{{ t('ui.home.DashboardPanel.cpus') }}</dt>
        <dd class="tabular-nums text-base-content/80">{{ sysinfo.cpuCount }}</dd>
      </div>
      <div class="flex justify-between gap-3">
        <dt class="text-base-content/70">{{ t('ui.home.DashboardPanel.load') }}</dt>
        <dd class="text-base-content/80 tabular-nums">
          {{ sysinfo.loadavg.map(n => n.toFixed(2)).join('  ') }}
        </dd>
      </div>
    </dl>
  </template>

  <!-- ---- Disk health (SMART) ---- -->
  <template v-else-if="w.type === 'smart'">
    <p class="eyebrow mb-3">{{ t('ui.home.DashboardPanel.diskHealth') }}</p>
    <div v-if="smartDevices.length === 0" class="flex-1 flex items-center text-xs text-base-content/70">
      {{ t('ui.home.DashboardPanel.noDrives') }}
    </div>
    <div v-else class="flex-1 flex flex-col gap-2.5 overflow-y-auto">
      <div v-for="dev in smartDevices" :key="dev" class="flex items-center gap-2.5">
        <span :class="['w-2 h-2 rounded-full shrink-0', SMART_DOT[smartStatus(smart[dev])] ?? SMART_DOT.unknown]"></span>
        <span class="font-mono text-xs text-base-content">{{ dev }}</span>
        <span class="text-2xs text-base-content/70 truncate flex-1" :title="smart[dev]?.modelName">
          {{ smart[dev]?.modelName ?? '' }}
        </span>
        <span v-if="smart[dev]?.available && smart[dev]?.temperature" class="text-2xs text-base-content/80 tabular-nums shrink-0">
          {{ smart[dev].temperature }}°C
        </span>
      </div>
    </div>
  </template>
</template>
