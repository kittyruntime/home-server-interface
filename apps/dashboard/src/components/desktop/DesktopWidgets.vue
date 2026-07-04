<script setup lang="ts">
import { computed } from 'vue'
import SegmentedBar from '../ui/SegmentedBar.vue'
import {
  useDashboardWidgets, CATALOG, spark, fmtBytes, fmtMem, memColor, type Widget,
} from '../../lib/dashboard-widgets'

defineEmits<{
  'contextmenu-widget': [widget: Widget, event: MouseEvent]
}>()

const {
  widgets, metrics,
  cpuHist, rxHist, txHist,
  ctrRunning, ctrStopped, ctrError,
  toggleCols, removeWidget, addWidget,
} = useDashboardWidgets()

const addableTypes = computed(() =>
  CATALOG.filter(cat => !widgets.value.some(w => w.type === cat.type))
)

defineExpose({ addableTypes, addWidget, removeWidget, toggleCols })
</script>

<template>
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-6">
    <div
      v-for="w in widgets" :key="w.id"
      :class="['relative bg-[var(--c-surface-alt)]/90 border border-[var(--c-border)] rounded-xl p-5 min-h-[130px] flex flex-col', w.cols === 2 ? 'col-span-2' : 'col-span-1']"
      @contextmenu.prevent.stop="$emit('contextmenu-widget', w, $event)"
    >
      <!-- ---- CPU ---- -->
      <template v-if="w.type === 'cpu'">
        <p class="eyebrow mb-3">CPU</p>
        <div class="flex items-end gap-4 flex-1">
          <div class="flex-shrink-0">
            <span
              class="text-4xl font-semibold tabular-nums leading-none text-[var(--c-text-display)]"
            >{{ metrics?.cpu ?? '—' }}</span>
            <span class="text-lg text-[var(--c-text-3)] ml-0.5">%</span>
          </div>
          <div class="flex-1 min-w-0">
            <svg
              v-if="cpuHist.length >= 2"
              viewBox="0 0 100 40"
              preserveAspectRatio="none"
              class="w-full h-10"
            >
              <path :d="spark(cpuHist, 0, 100).line" fill="none" stroke="var(--c-accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
            </svg>
          </div>
        </div>
      </template>

      <!-- ---- Memory ---- -->
      <template v-else-if="w.type === 'memory'">
        <p class="eyebrow mb-3">Memory</p>
        <div class="flex-1 flex flex-col justify-between">
          <div class="flex items-baseline justify-between mb-3">
            <span class="text-2xl font-bold text-[var(--c-text-3)] tabular-nums leading-none">
              {{ metrics ? fmtMem(metrics.memory.used) : '—' }}
            </span>
            <span class="text-xs text-[var(--c-text-3)]">
              of {{ metrics ? fmtMem(metrics.memory.total) : '—' }}
            </span>
          </div>
          <div class="space-y-1.5">
            <SegmentedBar
              :percent="metrics?.memory.percent ?? 0"
              :color="memColor(metrics?.memory.percent ?? 0)"
              height="compact"
            />
            <p class="text-xs text-[var(--c-text-3)] tabular-nums">{{ metrics?.memory.percent ?? 0 }}% used</p>
          </div>
        </div>
      </template>

      <!-- ---- Network ---- -->
      <template v-else-if="w.type === 'network'">
        <p class="eyebrow mb-3">Network</p>
        <div class="flex-1 flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <div class="space-y-0.5">
              <div class="flex items-center gap-1.5">
                <span class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-success)]">↓ rx</span>
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
                <path
                  v-if="rxHist.length >= 2"
                  :d="spark(rxHist).line"
                  fill="none" stroke="var(--c-success)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
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
        <p class="eyebrow mb-3">Containers</p>
        <div class="flex-1 flex items-center gap-6">
          <div class="text-center">
            <p class="text-3xl font-bold tabular-nums leading-none text-[var(--c-success)]">{{ ctrRunning }}</p>
            <p class="text-[10px] text-[var(--c-text-3)] uppercase tracking-widest mt-1">Running</p>
          </div>
          <div class="text-center">
            <p class="text-3xl font-bold text-[var(--c-text-3)] tabular-nums leading-none">{{ ctrStopped }}</p>
            <p class="text-[10px] text-[var(--c-text-3)] uppercase tracking-widest mt-1">Stopped</p>
          </div>
          <div class="text-center">
            <p class="text-3xl font-bold tabular-nums leading-none" :class="ctrError > 0 ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-3)]'">{{ ctrError }}</p>
            <p class="text-[10px] text-[var(--c-text-3)] uppercase tracking-widest mt-1">Error</p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
