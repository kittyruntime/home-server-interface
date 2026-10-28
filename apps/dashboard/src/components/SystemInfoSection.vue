<script setup lang="ts">
import { LayoutTemplateIcon, MonitorIcon, WifiIcon } from '@lucide/vue'
import LoadingState from './ui/LoadingState.vue'
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'

type Sysinfo = {
  hostname: string; platform: string; arch: string; release: string
  cpuModel: string; cpuCount: number
  ifaces: Array<{ name: string; addrs: Array<{ addr: string; family: string }> }>
}

const loading = ref(true)
const error   = ref('')
const sysinfo = ref<Sysinfo | null>(null)
const uptime  = ref<number | null>(null)

onMounted(async () => {
  try {
    const [s, m] = await Promise.all([
      trpc.system.sysinfo.query(),
      trpc.system.metrics.query(),
    ])
    sysinfo.value = s
    uptime.value  = (m as { uptime: number }).uptime
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load system info'
  } finally {
    loading.value = false
  }
})

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0 || d > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-foreground mb-1">System info</h2>
    <p class="text-sm text-muted-foreground mb-6">
      Hardware and OS facts for this host; these rarely change. For live usage and
      history, see Monitoring.
    </p>

    <LoadingState v-if="loading" variant="block" />
    <div v-else-if="error" role="alert" class="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{{ error }}</div>

    <template v-else-if="sysinfo">
      <div class="space-y-4">

        <!-- ── Overview ─────────────────────────────────────────────────── -->
        <div class="rounded-xl border border-border bg-card divide-y divide-border">
          <div class="px-4 py-3 flex items-center gap-2">
            <MonitorIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Overview</span>
          </div>

          <dl class="grid grid-cols-2 divide-x divide-border">
            <div class="px-4 py-3 space-y-3">
              <div>
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">Hostname</dt>
                <dd class="text-sm font-medium text-foreground font-mono">{{ sysinfo.hostname }}</dd>
              </div>
              <div>
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">Platform</dt>
                <dd class="text-sm text-foreground/80 capitalize">{{ sysinfo.platform }}</dd>
              </div>
              <div v-if="uptime != null">
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">Uptime</dt>
                <dd class="text-sm text-foreground/80 tabular-nums">{{ fmtUptime(uptime) }}</dd>
              </div>
            </div>
            <div class="px-4 py-3 space-y-3">
              <div>
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">Architecture</dt>
                <dd class="text-sm text-foreground/80 font-mono">{{ sysinfo.arch }}</dd>
              </div>
              <div>
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">Kernel</dt>
                <dd class="text-sm text-foreground/80 font-mono truncate" :title="sysinfo.release">{{ sysinfo.release }}</dd>
              </div>
            </div>
          </dl>
        </div>

        <!-- ── Processor ────────────────────────────────────────────────── -->
        <div class="rounded-xl border border-border bg-card overflow-hidden">
          <div class="px-4 py-3 flex items-center gap-2 border-b border-border">
            <LayoutTemplateIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Processor</span>
          </div>
          <div class="px-4 py-4 flex items-baseline gap-2">
            <span class="text-sm text-foreground leading-snug">{{ sysinfo.cpuModel }}</span>
            <span class="shrink-0 text-2xs px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground font-mono">×{{ sysinfo.cpuCount }}</span>
          </div>
        </div>

        <!-- ── Network interfaces ───────────────────────────────────────── -->
        <div class="rounded-xl border border-border bg-card overflow-hidden">
          <div class="px-4 py-3 flex items-center gap-2 border-b border-border">
            <WifiIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Network interfaces</span>
          </div>

          <div class="divide-y divide-border">
            <div
              v-for="iface in sysinfo.ifaces"
              :key="iface.name"
              class="px-4 py-3 flex items-start gap-3"
            >
              <span class="shrink-0 w-12 pt-0.5 font-mono text-xs font-medium text-foreground/80">{{ iface.name }}</span>
              <div class="flex flex-wrap gap-x-4 gap-y-1 flex-1 min-w-0">
                <span
                  v-for="a in iface.addrs"
                  :key="a.addr"
                  class="font-mono text-xs text-foreground/80 flex items-center gap-1.5"
                >
                  <span
                    class="text-2xs px-1 py-0.5 rounded-sm border"
                    :class="a.family === 'IPv6'
                      ? 'text-muted-foreground border-border'
                      : 'text-primary border-primary/30 bg-primary/10'"
                  >{{ a.family === 'IPv6' ? 'v6' : 'v4' }}</span>
                  {{ a.addr }}
                </span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </template>
  </div>
</template>
