<script setup lang="ts">
import { Progress } from '@/components/ui/progress'
import { Card } from '@/components/ui/card'
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
    <h2 class="text-lg font-semibold text-foreground mb-1">Summary</h2>
    <p class="text-sm text-muted-foreground mb-6">This NAS at a glance: system, storage, containers and recent activity.</p>

    <LoadingState v-if="isLoadingAll" variant="compact" />
    <ErrorState v-else-if="error" :message="error" compact />

    <template v-else>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">

        <!-- System card -->
        <Card class="block gap-0 py-0 overflow-hidden p-5">
          <div class="eyebrow mb-3">System</div>
          <div class="space-y-3">
            <div class="flex justify-between items-center">
              <span class="text-xs text-muted-foreground">Hostname</span>
              <span class="text-sm font-medium text-foreground font-mono">{{ sysinfo?.hostname ?? '-' }}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-xs text-muted-foreground">Uptime</span>
              <span class="text-sm text-foreground/80 tabular-nums">{{ metrics ? fmtUptime(metrics.uptime) : '-' }}</span>
            </div>
            <div v-if="metrics" class="space-y-1.5">
              <div class="flex justify-between text-xs">
                <span class="text-muted-foreground">CPU</span>
                <span class="tabular-nums font-medium"
                  :class="metrics.cpu >= 80 ? 'text-destructive' : metrics.cpu >= 60 ? 'text-warning' : 'text-foreground'"
                >{{ metrics.cpu }}%</span>
              </div>
              <Progress class="w-full h-1.5 bg-muted rounded-full" :model-value="metrics.cpu" :indicator-class="['rounded-full transition-all duration-700', metrics.cpu >= 80 ? 'bg-destructive' : metrics.cpu >= 60 ? 'bg-warning' : 'bg-primary']" />
            </div>
            <div v-if="metrics" class="flex justify-between items-center">
              <span class="text-xs text-muted-foreground">RAM</span>
              <span class="text-sm text-foreground/80 tabular-nums">
                {{ fmtBytes(metrics.memory.used) }} / {{ fmtBytes(metrics.memory.total) }}
              </span>
            </div>
          </div>
        </Card>

        <!-- Storage card -->
        <Card class="block gap-0 py-0 overflow-hidden p-5">
          <div class="eyebrow mb-3">Storage</div>
          <div class="space-y-3">
            <div class="flex justify-between items-center">
              <span class="text-xs text-muted-foreground">Used / Total</span>
              <span class="text-sm font-medium text-foreground tabular-nums">
                {{ fmtBytes(storageUsed) }} / {{ fmtBytes(storageTotal) }}
              </span>
            </div>
            <template v-if="raids.length > 0">
              <div class="text-2xs uppercase tracking-caps text-muted-foreground">RAID Arrays</div>
              <div v-for="r in raids" :key="r.name" class="flex items-center justify-between">
                <span class="text-xs font-mono text-foreground/80">{{ r.name }}</span>
                <span :class="['text-2xs font-semibold px-2 py-0.5 rounded-sm border',
                  isRaidHealthy(r)
                    ? 'bg-success/10 text-success border-success/20'
                    : 'bg-destructive/10 text-destructive border-destructive/20']">
                  {{ isRaidHealthy(r) ? 'Healthy' : 'Degraded' }}
                </span>
              </div>
            </template>
            <div v-else class="text-xs text-muted-foreground">No RAID arrays</div>
          </div>
        </Card>

        <!-- Containers card -->
        <Card class="block gap-0 py-0 overflow-hidden p-5">
          <div class="eyebrow mb-3">Containers</div>
          <div class="flex items-end gap-6">
            <div class="text-center">
              <div class="text-2xl font-bold text-foreground font-figure tabular-nums">{{ containerTotal }}</div>
              <div class="text-2xs text-muted-foreground mt-0.5">Total</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-success font-figure tabular-nums">{{ containerRunning }}</div>
              <div class="text-2xs text-muted-foreground mt-0.5">Running</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-foreground/80 font-figure tabular-nums">{{ containerStopped }}</div>
              <div class="text-2xs text-muted-foreground mt-0.5">Stopped</div>
            </div>
          </div>
        </Card>

        <!-- LVM card -->
        <Card class="block gap-0 py-0 overflow-hidden p-5">
          <div class="eyebrow mb-3">LVM</div>
          <div class="flex items-end gap-6">
            <div class="text-center">
              <div class="text-2xl font-bold text-foreground font-figure tabular-nums">{{ lvmVGs.length }}</div>
              <div class="text-2xs text-muted-foreground mt-0.5">Volume Groups</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-foreground font-figure tabular-nums">{{ lvmLVs.length }}</div>
              <div class="text-2xs text-muted-foreground mt-0.5">Logical Volumes</div>
            </div>
          </div>
        </Card>

        <!-- Recent Activity card (full width) -->
        <Card class="block gap-0 py-0 overflow-hidden p-5 lg:col-span-2">
          <div class="eyebrow mb-3">Recent Activity</div>
          <div v-if="!recentAudit.length" class="text-xs text-muted-foreground">No recent activity.</div>
          <div v-else class="divide-y divide-border">
            <div v-for="entry in recentAudit" :key="entry.id" class="flex items-center gap-3 py-2">
              <span :class="['w-1.5 h-1.5 rounded-full shrink-0', entry.success ? 'bg-success' : 'bg-destructive']" />
              <span class="text-2xs text-muted-foreground tabular-nums shrink-0 w-16">{{ relTime(entry.createdAt) }}</span>
              <span :class="['inline-flex text-2xs font-semibold px-2 py-0.5 rounded-sm border shrink-0', categoryClass[actionCategory(entry.action)]]">
                {{ actionLabel(entry.action) }}
              </span>
              <span class="text-xs text-foreground/80 truncate">
                {{ entry.user?.displayName || entry.user?.username || '-' }}
              </span>
            </div>
          </div>
        </Card>

      </div>
    </template>
  </div>
</template>
