<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import SegmentedBar from '../ui/SegmentedBar.vue'
import {
  useDashboardWidgets, catalogFor, spark, fmtBytes, fmtMem, memColor, fmtGB, diskColor,
} from '../../lib/dashboard-widgets'
import { smartStatus } from '../../composables/useSmart'
import { useAuth } from '../../lib/auth'

const {
  widgets, metrics,
  cpuHist, rxHist, txHist,
  uptimeStr, ctrRunning, ctrStopped, ctrError,
  disks, sysinfo, smart, smartDevices,
  toggleCols, removeWidget, addWidget,
} = useDashboardWidgets()

const { isAdmin } = useAuth()
const catalog = computed(() => catalogFor(isAdmin.value))

const SMART_DOT: Record<string, string> = {
  passed:  'bg-[var(--c-success)]',
  warning: 'bg-[var(--c-warning)]',
  failed:  'bg-[var(--c-accent)]',
  loading: 'bg-[var(--c-text-3)] animate-pulse',
  unknown: 'bg-[var(--c-text-3)]',
}

const addOpen = ref(false)

function onAddWidget(type: Parameters<typeof addWidget>[0]) {
  addWidget(type)
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
        <span v-if="metrics" class="text-xs text-[var(--c-text-3)] font-mono">{{ uptimeStr }}</span>
      </div>

      <!-- Add widget dropdown -->
      <div class="relative">
        <button
          @click.stop="addOpen = !addOpen"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--c-surface-deep)] border border-[var(--c-border-strong)] text-[var(--c-text-2)] text-sm rounded-lg hover:bg-[var(--c-hover)] transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Add
        </button>

        <Transition name="dropdown">
          <div
            v-if="addOpen"
            class="absolute right-0 top-full mt-1.5 bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl overflow-hidden z-20 min-w-[140px]"
          >
            <button
              v-for="cat in catalog"
              :key="cat.type"
              @click.stop="onAddWidget(cat.type)"
              class="w-full text-left px-4 py-2.5 text-sm text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors"
            >
              {{ cat.label }}
            </button>
          </div>
        </Transition>
      </div>
    </div>

    <!-- Widget grid -->
    <div class="flex-1 overflow-y-auto p-4 sm:p-6">
      <div v-if="widgets.length === 0" class="flex flex-col items-center justify-center h-full gap-3 text-[var(--c-text-3)]">
        <svg class="w-10 h-10 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/>
        </svg>
        <p class="text-sm">No widgets. Click <strong class="text-[var(--c-text-2)]">Add</strong> to get started.</p>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="w in widgets" :key="w.id"
          :class="['relative group/card bg-[var(--c-surface-alt)] border border-[var(--c-border)] rounded-xl p-5 min-h-[130px] flex flex-col', w.cols === 2 ? 'col-span-2' : 'col-span-1']"
        >
          <!-- Widget controls -->
          <div class="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity">
            <button
              @click="toggleCols(w)"
              :title="w.cols === 1 ? 'Expand' : 'Shrink'"
              class="w-6 h-6 flex items-center justify-center text-[var(--c-text-3)] hover:text-[var(--c-text-2)] hover:bg-[var(--c-hover)] rounded-md transition-colors text-xs"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 9l4-4 4 4M8 15l4 4 4-4" v-if="w.cols === 1"/>
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 8l-4 4 4 4M15 8l4 4-4 4" v-else/>
              </svg>
            </button>
            <button
              @click="removeWidget(w.id)"
              title="Remove"
              class="w-6 h-6 flex items-center justify-center text-[var(--c-text-3)] hover:text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] rounded-md transition-colors"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

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

          <!-- ---- Storage ---- -->
          <template v-else-if="w.type === 'storage'">
            <p class="eyebrow mb-3">Storage</p>
            <div v-if="disks.length === 0" class="flex-1 flex items-center text-xs text-[var(--c-text-3)]">
              No filesystems
            </div>
            <div v-else class="flex-1 flex flex-col gap-3 overflow-y-auto">
              <div v-for="d in disks" :key="d.mountPoint">
                <div class="flex items-baseline justify-between mb-1 gap-2">
                  <span class="text-xs font-mono text-[var(--c-text-1)] truncate" :title="d.mountPoint">{{ d.mountPoint }}</span>
                  <span class="text-[11px] text-[var(--c-text-3)] tabular-nums shrink-0">
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
            <p class="eyebrow mb-3">System</p>
            <div v-if="!sysinfo" class="flex-1 flex items-center text-xs text-[var(--c-text-3)]">—</div>
            <dl v-else class="flex-1 flex flex-col justify-center gap-2 text-sm">
              <div class="flex justify-between gap-3">
                <dt class="text-[var(--c-text-3)]">Host</dt>
                <dd class="font-mono text-[var(--c-text-1)] truncate" :title="sysinfo.hostname">{{ sysinfo.hostname }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-[var(--c-text-3)]">OS</dt>
                <dd class="text-[var(--c-text-2)] truncate capitalize" :title="`${sysinfo.platform} ${sysinfo.release}`">{{ sysinfo.platform }} {{ sysinfo.release }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-[var(--c-text-3)]">CPUs</dt>
                <dd class="font-mono text-[var(--c-text-2)]">{{ sysinfo.cpuCount }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-[var(--c-text-3)]">Load</dt>
                <dd class="font-mono text-[var(--c-text-2)] tabular-nums">
                  {{ sysinfo.loadavg.map(n => n.toFixed(2)).join('  ') }}
                </dd>
              </div>
            </dl>
          </template>

          <!-- ---- Disk health (SMART) ---- -->
          <template v-else-if="w.type === 'smart'">
            <p class="eyebrow mb-3">Disk Health</p>
            <div v-if="smartDevices.length === 0" class="flex-1 flex items-center text-xs text-[var(--c-text-3)]">
              No drives
            </div>
            <div v-else class="flex-1 flex flex-col gap-2.5 overflow-y-auto">
              <div v-for="dev in smartDevices" :key="dev" class="flex items-center gap-2.5">
                <span :class="['w-2 h-2 rounded-full shrink-0', SMART_DOT[smartStatus(smart[dev])] ?? SMART_DOT.unknown]"></span>
                <span class="text-xs font-mono text-[var(--c-text-1)]">{{ dev }}</span>
                <span class="text-[11px] text-[var(--c-text-3)] truncate flex-1" :title="smart[dev]?.modelName">
                  {{ smart[dev]?.modelName ?? '' }}
                </span>
                <span v-if="smart[dev]?.available && smart[dev]?.temperature" class="text-[11px] text-[var(--c-text-2)] tabular-nums shrink-0">
                  {{ smart[dev].temperature }}°C
                </span>
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
