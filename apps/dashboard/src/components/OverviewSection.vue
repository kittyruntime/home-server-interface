<script setup lang="ts">
import { actionLabel, actionCategory, categoryClass } from '../lib/audit-labels'
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { useStorageData, fmtBytes, isRaidHealthy } from './storage/store'
import type { BlockDev } from './storage/store'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'

const { devices, raids, lvmVGs, lvmLVs, loading: storageLoading } = useStorageData()

type Metrics = {
  cpu: number
  memory: { total: number; used: number; percent: number }
  uptime: number
}

const metrics     = ref<Metrics | null>(null)
const sysinfo     = ref<{ hostname: string } | null>(null)
const containers  = ref<Array<{ id: string; name: string; status: string }>>([])
const recentAudit = ref<Array<{
  id: string
  createdAt: string | Date
  action: string
  success: boolean
  user?: { displayName?: string | null; username: string } | null
}>>([])
const loading = ref(true)
const error   = ref('')

onMounted(async () => {
  try {
    const [m, s, c, a] = await Promise.all([
      trpc.system.metrics.query(),
      trpc.system.sysinfo.query(),
      trpc.container.app.list.query(),
      trpc.audit.list.query({ page: 0, limit: 5 }),
    ])
    metrics.value    = m as Metrics
    sysinfo.value    = s
    containers.value = c as Array<{ id: string; name: string; status: string }>
    recentAudit.value = (a as { entries: typeof recentAudit.value }).entries
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load overview'
  } finally {
    loading.value = false
  }
})

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0 || d > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

function allBlockDevs(devs: BlockDev[]): BlockDev[] {
  const result: BlockDev[] = []
  function walk(d: BlockDev) { result.push(d); d.children?.forEach(walk) }
  devs.forEach(walk)
  return result
}

const mountedDevices = computed(() =>
  allBlockDevs(devices.value).filter(d => d.mountpoint && d.usageTotal > 0)
)
const storageTotal = computed(() => mountedDevices.value.reduce((a, d) => a + d.usageTotal, 0))
const storageUsed  = computed(() => mountedDevices.value.reduce((a, d) => a + d.usageUsed, 0))

const containerTotal   = computed(() => containers.value.length)
const containerRunning = computed(() => containers.value.filter(c => c.status === 'running').length)
const containerStopped = computed(() => containers.value.filter(c => c.status !== 'running').length)

const isLoadingAll = computed(() => loading.value || storageLoading.value)

// ── Audit helpers ─────────────────────────────────────────────────────────────





function relTime(d: string | Date): string {
  const diff = Date.now() - new Date(d).getTime()
  const min  = Math.floor(diff / 60000)
  const h    = Math.floor(diff / 3600000)
  const day  = Math.floor(diff / 86400000)
  if (min < 1)  return 'just now'
  if (min < 60) return `${min} min ago`
  if (h < 24)   return `${h}h ago`
  return `${day}d ago`
}
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-[var(--c-text-1)] mb-1">Overview</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">Dashboard summary for this NAS.</p>

    <LoadingState v-if="isLoadingAll" variant="compact" />
    <ErrorState v-else-if="error" :message="error" compact />

    <template v-else>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">

        <!-- System card -->
        <div class="panel-card p-5 bg-[var(--c-surface)]">
          <div class="eyebrow mb-3">System</div>
          <div class="space-y-3">
            <div class="flex justify-between items-center">
              <span class="text-xs text-[var(--c-text-3)]">Hostname</span>
              <span class="text-sm font-medium text-[var(--c-text-1)] font-mono">{{ sysinfo?.hostname ?? '-' }}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-xs text-[var(--c-text-3)]">Uptime</span>
              <span class="text-sm text-[var(--c-text-2)] tabular-nums">{{ metrics ? fmtUptime(metrics.uptime) : '-' }}</span>
            </div>
            <div v-if="metrics" class="space-y-1.5">
              <div class="flex justify-between text-xs">
                <span class="text-[var(--c-text-3)]">CPU</span>
                <span class="tabular-nums font-medium"
                  :class="metrics.cpu >= 80 ? 'text-danger' : metrics.cpu >= 60 ? 'text-warning' : 'text-[var(--c-text-1)]'"
                >{{ metrics.cpu }}%</span>
              </div>
              <div class="w-full h-1.5 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-700"
                  :class="metrics.cpu >= 80 ? 'bg-danger' : metrics.cpu >= 60 ? 'bg-warning' : 'bg-[var(--c-accent)]'"
                  :style="{ width: metrics.cpu + '%' }"
                />
              </div>
            </div>
            <div v-if="metrics" class="flex justify-between items-center">
              <span class="text-xs text-[var(--c-text-3)]">RAM</span>
              <span class="text-sm text-[var(--c-text-2)] tabular-nums">
                {{ fmtBytes(metrics.memory.used) }} / {{ fmtBytes(metrics.memory.total) }}
              </span>
            </div>
          </div>
        </div>

        <!-- Storage card -->
        <div class="panel-card p-5 bg-[var(--c-surface)]">
          <div class="eyebrow mb-3">Storage</div>
          <div class="space-y-3">
            <div class="flex justify-between items-center">
              <span class="text-xs text-[var(--c-text-3)]">Used / Total</span>
              <span class="text-sm font-medium text-[var(--c-text-1)] tabular-nums">
                {{ fmtBytes(storageUsed) }} / {{ fmtBytes(storageTotal) }}
              </span>
            </div>
            <template v-if="raids.length > 0">
              <div class="text-2xs uppercase tracking-caps text-[var(--c-text-3)]">RAID Arrays</div>
              <div v-for="r in raids" :key="r.name" class="flex items-center justify-between">
                <span class="text-xs font-mono text-[var(--c-text-2)]">{{ r.name }}</span>
                <span :class="['text-2xs font-semibold px-2 py-0.5 rounded-sm border',
                  isRaidHealthy(r)
                    ? 'bg-success/10 text-success border-success/20'
                    : 'bg-danger/10 text-danger border-danger/20']">
                  {{ isRaidHealthy(r) ? 'Healthy' : 'Degraded' }}
                </span>
              </div>
            </template>
            <div v-else class="text-xs text-[var(--c-text-3)] italic">No RAID arrays</div>
          </div>
        </div>

        <!-- Containers card -->
        <div class="panel-card p-5 bg-[var(--c-surface)]">
          <div class="eyebrow mb-3">Containers</div>
          <div class="flex items-end gap-6">
            <div class="text-center">
              <div class="text-2xl font-bold text-[var(--c-text-1)] font-figure tabular-nums">{{ containerTotal }}</div>
              <div class="text-2xs text-[var(--c-text-3)] mt-0.5">Total</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-success font-figure tabular-nums">{{ containerRunning }}</div>
              <div class="text-2xs text-[var(--c-text-3)] mt-0.5">Running</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-[var(--c-text-2)] font-figure tabular-nums">{{ containerStopped }}</div>
              <div class="text-2xs text-[var(--c-text-3)] mt-0.5">Stopped</div>
            </div>
          </div>
        </div>

        <!-- LVM card -->
        <div class="panel-card p-5 bg-[var(--c-surface)]">
          <div class="eyebrow mb-3">LVM</div>
          <div class="flex items-end gap-6">
            <div class="text-center">
              <div class="text-2xl font-bold text-[var(--c-text-1)] font-figure tabular-nums">{{ lvmVGs.length }}</div>
              <div class="text-2xs text-[var(--c-text-3)] mt-0.5">Volume Groups</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-[var(--c-text-1)] font-figure tabular-nums">{{ lvmLVs.length }}</div>
              <div class="text-2xs text-[var(--c-text-3)] mt-0.5">Logical Volumes</div>
            </div>
          </div>
        </div>

        <!-- Recent Activity card (full width) -->
        <div class="panel-card p-5 bg-[var(--c-surface)] lg:col-span-2">
          <div class="eyebrow mb-3">Recent Activity</div>
          <div v-if="!recentAudit.length" class="text-xs text-[var(--c-text-3)] italic">No recent activity.</div>
          <div v-else class="divide-y divide-[var(--c-border)]">
            <div v-for="entry in recentAudit" :key="entry.id" class="flex items-center gap-3 py-2">
              <span :class="['w-1.5 h-1.5 rounded-full shrink-0', entry.success ? 'bg-success' : 'bg-danger']" />
              <span class="text-2xs text-[var(--c-text-3)] tabular-nums shrink-0 w-16">{{ relTime(entry.createdAt) }}</span>
              <span :class="['inline-flex text-2xs font-semibold px-2 py-0.5 rounded-sm border shrink-0', categoryClass[actionCategory(entry.action)]]">
                {{ actionLabel(entry.action) }}
              </span>
              <span class="text-xs text-[var(--c-text-2)] truncate">
                {{ entry.user?.displayName || entry.user?.username || '-' }}
              </span>
            </div>
          </div>
        </div>

      </div>
    </template>
  </div>
</template>
