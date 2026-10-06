<script setup lang="ts">
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
    <h2 class="text-lg font-semibold text-[var(--c-text-1)] mb-1">System Info</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">
      Hardware and OS facts for this host; these rarely change. For live usage and
      history, see Monitoring.
    </p>

    <LoadingState v-if="loading" variant="block" />
    <div v-else-if="error" role="alert" class="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{{ error }}</div>

    <template v-else-if="sysinfo">
      <div class="space-y-4">

        <!-- ── Overview ─────────────────────────────────────────────────── -->
        <div class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] divide-y divide-[var(--c-border)]">
          <div class="px-4 py-3 flex items-center gap-2">
            <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            <span class="text-2xs font-semibold uppercase tracking-caps text-[var(--c-text-3)]">Overview</span>
          </div>

          <dl class="grid grid-cols-2 divide-x divide-[var(--c-border)]">
            <div class="px-4 py-3 space-y-3">
              <div>
                <dt class="text-2xs uppercase tracking-caps text-[var(--c-text-3)] mb-0.5">Hostname</dt>
                <dd class="text-sm font-medium text-[var(--c-text-1)] font-mono">{{ sysinfo.hostname }}</dd>
              </div>
              <div>
                <dt class="text-2xs uppercase tracking-caps text-[var(--c-text-3)] mb-0.5">Platform</dt>
                <dd class="text-sm text-[var(--c-text-2)] capitalize">{{ sysinfo.platform }}</dd>
              </div>
              <div v-if="uptime != null">
                <dt class="text-2xs uppercase tracking-caps text-[var(--c-text-3)] mb-0.5">Uptime</dt>
                <dd class="text-sm text-[var(--c-text-2)] tabular-nums">{{ fmtUptime(uptime) }}</dd>
              </div>
            </div>
            <div class="px-4 py-3 space-y-3">
              <div>
                <dt class="text-2xs uppercase tracking-caps text-[var(--c-text-3)] mb-0.5">Architecture</dt>
                <dd class="text-sm text-[var(--c-text-2)] font-mono">{{ sysinfo.arch }}</dd>
              </div>
              <div>
                <dt class="text-2xs uppercase tracking-caps text-[var(--c-text-3)] mb-0.5">Kernel</dt>
                <dd class="text-sm text-[var(--c-text-2)] font-mono truncate" :title="sysinfo.release">{{ sysinfo.release }}</dd>
              </div>
            </div>
          </dl>
        </div>

        <!-- ── Processor ────────────────────────────────────────────────── -->
        <div class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] overflow-hidden">
          <div class="px-4 py-3 flex items-center gap-2 border-b border-[var(--c-border)]">
            <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
            </svg>
            <span class="text-2xs font-semibold uppercase tracking-caps text-[var(--c-text-3)]">Processor</span>
          </div>
          <div class="px-4 py-4 flex items-baseline gap-2">
            <span class="text-sm text-[var(--c-text-1)] leading-snug">{{ sysinfo.cpuModel }}</span>
            <span class="shrink-0 text-2xs px-1.5 py-0.5 rounded-sm bg-[var(--c-surface-deep)] text-[var(--c-text-3)] font-mono">×{{ sysinfo.cpuCount }}</span>
          </div>
        </div>

        <!-- ── Network interfaces ───────────────────────────────────────── -->
        <div class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] overflow-hidden">
          <div class="px-4 py-3 flex items-center gap-2 border-b border-[var(--c-border)]">
            <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"/>
            </svg>
            <span class="text-2xs font-semibold uppercase tracking-caps text-[var(--c-text-3)]">Network interfaces</span>
          </div>

          <div class="divide-y divide-[var(--c-border)]">
            <div
              v-for="iface in sysinfo.ifaces"
              :key="iface.name"
              class="px-4 py-3 flex items-start gap-3"
            >
              <span class="shrink-0 w-12 pt-0.5 font-mono text-xs font-medium text-[var(--c-text-2)]">{{ iface.name }}</span>
              <div class="flex flex-wrap gap-x-4 gap-y-1 flex-1 min-w-0">
                <span
                  v-for="a in iface.addrs"
                  :key="a.addr"
                  class="font-mono text-xs text-[var(--c-text-2)] flex items-center gap-1.5"
                >
                  <span
                    class="text-2xs px-1 py-0.5 rounded-sm border"
                    :class="a.family === 'IPv6'
                      ? 'text-[var(--c-text-3)] border-[var(--c-border)]'
                      : 'text-[var(--c-accent)] border-[var(--c-accent)]/30 bg-[var(--c-accent-subtle)]'"
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
