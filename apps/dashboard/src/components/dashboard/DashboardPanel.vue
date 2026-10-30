<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ChevronsLeftRightIcon, ChevronsUpDownIcon, LayoutGridIcon, PlusIcon, XIcon } from '@lucide/vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { computed } from 'vue'
import SegmentedBar from '../ui/SegmentedBar.vue'
import GettingStartedCard from './GettingStartedCard.vue'
import HttpsBanner from './HttpsBanner.vue'
import {
  useDashboardWidgets, catalogFor, spark, fmtBytes, fmtMem, memColor, fmtGB, diskColor,
} from '../../lib/dashboard-widgets'
import { smartStatus } from '../storage/smart'
import { useAuth } from '../../lib/auth'

const { t } = useI18n()

const {
  widgets, metrics,
  cpuHist, rxHist, txHist,
  uptimeStr, ctrRunning, ctrStopped, ctrError,
  disks, sysinfo, smart, smartDevices,
  toggleCols, removeWidget, addWidget,
} = useDashboardWidgets()

const emit = defineEmits<{ navigate: [target: 'places' | 'store' | 'backups' | 'secure'] }>()

const { isAdmin, hasCapability } = useAuth()
const catalog = computed(() => catalogFor(isAdmin.value, cap => hasCapability(cap).value))

const SMART_DOT: Record<string, string> = {
  passed:  'bg-success',
  warning: 'bg-warning',
  failed:  'bg-primary',
  loading: 'bg-muted-foreground animate-pulse',
  unknown: 'bg-muted-foreground',
}

</script>

<template>
  <div class="flex flex-col h-full">

    <!-- Toolbar -->
    <div class="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 border-b border-border flex-shrink-0">
      <div class="flex items-center gap-3">
        <h3 class="text-sm font-semibold text-foreground">{{ t('ui.home.DashboardPanel.overview') }}</h3>
        <span v-if="metrics" class="text-xs text-muted-foreground font-mono">{{ uptimeStr }}</span>
      </div>

      <!-- Add widget dropdown -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="sm">
            <PlusIcon aria-hidden="true" />
            {{ t('ui.home.DashboardPanel.add') }}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-[140px]">
          <DropdownMenuItem v-for="cat in catalog" :key="cat.type" @select="addWidget(cat.type)">
            {{ cat.label }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <HttpsBanner v-if="isAdmin" @navigate="emit('navigate', $event)" />
    <GettingStartedCard v-if="isAdmin" @navigate="emit('navigate', $event)" />

    <!-- Widget grid -->
    <div class="flex-1 overflow-y-auto p-4 sm:p-6">
      <div v-if="widgets.length === 0" class="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <LayoutGridIcon class="w-10 h-10 opacity-20" aria-hidden="true" />
        <p class="text-sm">{{ t('ui.home.DashboardPanel.noWidgetsClick') }} <strong class="text-foreground/80">{{ t('ui.home.DashboardPanel.add') }}</strong> {{ t('ui.home.DashboardPanel.toGetStarted') }}</p>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="w in widgets" :key="w.id"
          :class="['relative group/card bg-muted border border-border rounded-xl p-4 sm:p-5 min-h-[130px] flex flex-col', w.cols === 2 ? 'col-span-1 sm:col-span-2' : 'col-span-1']"
        >
          <!-- Widget controls -->
          <div class="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover/card:opacity-100 focus-within:opacity-100 transition-opacity">
            <Button variant="ghost" size="icon-xs"
              @click="toggleCols(w)"
              :tooltip="w.cols === 1 ? 'Expand' : 'Shrink'"
              :aria-label="w.cols === 1 ? 'Expand widget' : 'Shrink widget'"
              class="text-muted-foreground"
            >
              <component :is="w.cols === 1 ? ChevronsLeftRightIcon : ChevronsUpDownIcon" class="size-3.5" aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon-xs"
              @click="removeWidget(w.id)"
              :tooltip="t('ui.home.DashboardPanel.remove')" :aria-label="t('ui.home.DashboardPanel.remove')"
              class="text-muted-foreground hover:text-primary hover:bg-primary/10"
            >
              <XIcon class="w-3 h-3" aria-hidden="true" />
            </Button>
          </div>

          <!-- ---- CPU ---- -->
          <template v-if="w.type === 'cpu'">
            <p class="eyebrow mb-3">CPU</p>
            <div class="flex items-end gap-4 flex-1">
              <div class="flex-shrink-0">
                <span
                  class="text-4xl font-semibold font-figure tabular-nums leading-none text-foreground"
                >{{ metrics?.cpu ?? '-' }}</span>
                <span class="text-lg text-muted-foreground ml-0.5">%</span>
              </div>
              <div class="flex-1 min-w-0">
                <svg
                  v-if="cpuHist.length >= 2"
                  viewBox="0 0 100 40"
                  preserveAspectRatio="none"
                  class="w-full h-10"
                >
                  <path :d="spark(cpuHist, 0, 100).line" fill="none" stroke="var(--primary)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
                </svg>
              </div>
            </div>
          </template>

          <!-- ---- Memory ---- -->
          <template v-else-if="w.type === 'memory'">
            <p class="eyebrow mb-3">{{ t('ui.home.DashboardPanel.memory') }}</p>
            <div class="flex-1 flex flex-col justify-between">
              <div class="flex items-baseline justify-between mb-3">
                <span class="text-2xl font-bold text-muted-foreground font-figure tabular-nums leading-none">
                  {{ metrics ? fmtMem(metrics.memory.used) : '-' }}
                </span>
                <span class="text-xs text-muted-foreground">
                  of {{ metrics ? fmtMem(metrics.memory.total) : '-' }}
                </span>
              </div>
              <div class="space-y-1.5">
                <SegmentedBar
                  :percent="metrics?.memory.percent ?? 0"
                  :color="memColor(metrics?.memory.percent ?? 0)"
                  height="compact"
                />
                <p class="text-xs text-muted-foreground tabular-nums">{{ t('uip.home.DashboardPanel.used', { p0: metrics?.memory.percent ?? 0 }) }}</p>
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
                    <span class="text-sm font-mono text-foreground">{{ metrics ? fmtBytes(metrics.network.rx) : '-' }}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="text-2xs font-semibold text-primary uppercase tracking-caps">{{ t('ui.home.DashboardPanel.tx') }}</span>
                    <span class="text-sm font-mono text-foreground">{{ metrics ? fmtBytes(metrics.network.tx) : '-' }}</span>
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
                      fill="none" stroke="var(--success)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
                    />
                    <path
                      v-if="txHist.length >= 2"
                      :d="spark(txHist).line"
                      fill="none" stroke="var(--primary)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
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
                <p class="text-2xs text-muted-foreground uppercase tracking-caps mt-1">{{ t('ui.home.DashboardPanel.running') }}</p>
              </div>
              <div class="text-center">
                <p class="text-3xl font-bold text-muted-foreground font-figure tabular-nums leading-none">{{ ctrStopped }}</p>
                <p class="text-2xs text-muted-foreground uppercase tracking-caps mt-1">{{ t('ui.home.DashboardPanel.stopped') }}</p>
              </div>
              <div class="text-center">
                <p class="text-3xl font-bold font-figure tabular-nums leading-none" :class="ctrError > 0 ? 'text-primary' : 'text-muted-foreground'">{{ ctrError }}</p>
                <p class="text-2xs text-muted-foreground uppercase tracking-caps mt-1">{{ t('ui.home.DashboardPanel.error') }}</p>
              </div>
            </div>
          </template>

          <!-- ---- Storage ---- -->
          <template v-else-if="w.type === 'storage'">
            <p class="eyebrow mb-3">{{ t('ui.home.DashboardPanel.storage') }}</p>
            <div v-if="disks.length === 0" class="flex-1 flex items-center text-xs text-muted-foreground">
              {{ t('ui.home.DashboardPanel.noFilesystems') }}
            </div>
            <div v-else class="flex-1 flex flex-col gap-3 overflow-y-auto">
              <div v-for="d in disks" :key="d.mountPoint">
                <div class="flex items-baseline justify-between mb-1 gap-2">
                  <span class="text-xs font-mono text-foreground truncate" :title="d.mountPoint">{{ d.mountPoint }}</span>
                  <span class="text-2xs text-muted-foreground tabular-nums shrink-0">
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
            <div v-if="!sysinfo" class="flex-1 flex items-center text-xs text-muted-foreground">-</div>
            <dl v-else class="flex-1 flex flex-col justify-center gap-2 text-sm">
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">{{ t('ui.home.DashboardPanel.host') }}</dt>
                <dd class="font-mono text-foreground truncate" :title="sysinfo.hostname">{{ sysinfo.hostname }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">OS</dt>
                <dd class="text-foreground/80 truncate capitalize" :title="`${sysinfo.platform} ${sysinfo.release}`">{{ sysinfo.platform }} {{ sysinfo.release }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">{{ t('ui.home.DashboardPanel.cpus') }}</dt>
                <dd class="font-mono text-foreground/80">{{ sysinfo.cpuCount }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">{{ t('ui.home.DashboardPanel.load') }}</dt>
                <dd class="font-mono text-foreground/80 tabular-nums">
                  {{ sysinfo.loadavg.map(n => n.toFixed(2)).join('  ') }}
                </dd>
              </div>
            </dl>
          </template>

          <!-- ---- Disk health (SMART) ---- -->
          <template v-else-if="w.type === 'smart'">
            <p class="eyebrow mb-3">{{ t('ui.home.DashboardPanel.diskHealth') }}</p>
            <div v-if="smartDevices.length === 0" class="flex-1 flex items-center text-xs text-muted-foreground">
              {{ t('ui.home.DashboardPanel.noDrives') }}
            </div>
            <div v-else class="flex-1 flex flex-col gap-2.5 overflow-y-auto">
              <div v-for="dev in smartDevices" :key="dev" class="flex items-center gap-2.5">
                <span :class="['w-2 h-2 rounded-full shrink-0', SMART_DOT[smartStatus(smart[dev])] ?? SMART_DOT.unknown]"></span>
                <span class="text-xs font-mono text-foreground">{{ dev }}</span>
                <span class="text-2xs text-muted-foreground truncate flex-1" :title="smart[dev]?.modelName">
                  {{ smart[dev]?.modelName ?? '' }}
                </span>
                <span v-if="smart[dev]?.available && smart[dev]?.temperature" class="text-2xs text-foreground/80 tabular-nums shrink-0">
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

