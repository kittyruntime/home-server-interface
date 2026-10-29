<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { LayoutTemplateIcon, MonitorIcon, WifiIcon } from '@lucide/vue'
import LoadingState from './ui/LoadingState.vue'
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'

const { t } = useI18n()

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
    error.value = e?.message ?? t('uis.settings.SystemInfoSection.failedToLoadSystemInfo')
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
    <h2 class="text-lg font-semibold text-foreground mb-1">{{ t('ui.monitor.SystemInfoSection.systemInfo') }}</h2>
    <p class="text-sm text-muted-foreground mb-6">
      {{ t('ui.monitor.SystemInfoSection.hardwareAndOsFactsFor') }}
    </p>

    <LoadingState v-if="loading" variant="block" />
    <Alert variant="destructive" v-else-if="error" class="mt-4"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <template v-else-if="sysinfo">
      <div class="space-y-4">

        <!-- ── Overview ─────────────────────────────────────────────────── -->
        <Card class="block gap-0 py-0 shadow-none divide-y divide-border">
          <div class="px-4 py-3 flex items-center gap-2">
            <MonitorIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.monitor.SystemInfoSection.overview') }}</span>
          </div>

          <dl class="grid grid-cols-2 divide-x divide-border">
            <div class="px-4 py-3 space-y-3">
              <div>
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">{{ t('ui.monitor.SystemInfoSection.hostname') }}</dt>
                <dd class="text-sm font-medium text-foreground font-mono">{{ sysinfo.hostname }}</dd>
              </div>
              <div>
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">{{ t('ui.monitor.SystemInfoSection.platform') }}</dt>
                <dd class="text-sm text-foreground/80 capitalize">{{ sysinfo.platform }}</dd>
              </div>
              <div v-if="uptime != null">
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">{{ t('ui.monitor.SystemInfoSection.uptime') }}</dt>
                <dd class="text-sm text-foreground/80 tabular-nums">{{ fmtUptime(uptime) }}</dd>
              </div>
            </div>
            <div class="px-4 py-3 space-y-3">
              <div>
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">{{ t('ui.monitor.SystemInfoSection.architecture') }}</dt>
                <dd class="text-sm text-foreground/80 font-mono">{{ sysinfo.arch }}</dd>
              </div>
              <div>
                <dt class="text-2xs uppercase tracking-caps text-muted-foreground mb-0.5">{{ t('ui.monitor.SystemInfoSection.kernel') }}</dt>
                <dd class="text-sm text-foreground/80 font-mono truncate" :title="sysinfo.release">{{ sysinfo.release }}</dd>
              </div>
            </div>
          </dl>
        </Card>

        <!-- ── Processor ────────────────────────────────────────────────── -->
        <Card class="block gap-0 py-0 shadow-none overflow-hidden">
          <div class="px-4 py-3 flex items-center gap-2 border-b border-border">
            <LayoutTemplateIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.monitor.SystemInfoSection.processor') }}</span>
          </div>
          <div class="px-4 py-4 flex items-baseline gap-2">
            <span class="text-sm text-foreground leading-snug">{{ sysinfo.cpuModel }}</span>
            <span class="shrink-0 text-2xs px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground font-mono">×{{ sysinfo.cpuCount }}</span>
          </div>
        </Card>

        <!-- ── Network interfaces ───────────────────────────────────────── -->
        <Card class="block gap-0 py-0 shadow-none overflow-hidden">
          <div class="px-4 py-3 flex items-center gap-2 border-b border-border">
            <WifiIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.monitor.SystemInfoSection.networkInterfaces') }}</span>
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
        </Card>

      </div>
    </template>
  </div>
</template>
