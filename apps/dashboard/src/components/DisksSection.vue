<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import LoadingSpinner from './ui/LoadingSpinner.vue'

type DiskInfo  = { device: string; mountPoint: string; fsType: string; total: number; used: number; free: number }
type RaidArray = { name: string; level: string; state: string; devices: string[]; active: number; total: number }

const loading = ref(true)
const error   = ref('')
const disks   = ref<DiskInfo[]>([])
const raids   = ref<RaidArray[]>([])

onMounted(async () => {
  try {
    const res = await trpc.system.disks.query()
    disks.value = res.disks
    raids.value = res.raids
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load disk info'
  } finally {
    loading.value = false
  }
})

function fmtBytes(n: number): string {
  if (n <= 0)             return '0 B'
  if (n < 1024)           return `${n} B`
  if (n < 1024 ** 2)      return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3)      return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n < 1024 ** 4)      return `${(n / 1024 ** 3).toFixed(2)} GB`
  return `${(n / 1024 ** 4).toFixed(2)} TB`
}

function usedPct(d: DiskInfo): number {
  return d.total > 0 ? Math.min(100, (d.used / d.total) * 100) : 0
}

function raidLevelLabel(level: string): string {
  const map: Record<string, string> = {
    raid0: 'RAID 0', raid1: 'RAID 1', raid5: 'RAID 5',
    raid6: 'RAID 6', raid10: 'RAID 10', linear: 'Linear',
  }
  return map[level] ?? level.toUpperCase()
}
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-[var(--c-text-1)] mb-1">Storage &amp; Disks</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">Mounted filesystems and RAID arrays detected on this host.</p>

    <div v-if="loading" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm">
      <LoadingSpinner /> Loading…
    </div>
    <div v-else-if="error" class="text-sm text-[var(--c-accent)]">{{ error }}</div>

    <template v-else>

      <!-- ── Filesystems ─────────────────────────────────────────────────── -->
      <div v-if="disks.length === 0" class="text-sm text-[var(--c-text-3)]">No mounted block devices found.</div>
      <div v-else class="space-y-4 mb-8">
        <div
          v-for="d in disks"
          :key="d.device + d.mountPoint"
          class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] p-4 space-y-3"
        >
          <!-- Header -->
          <div class="flex items-start gap-3">
            <div class="mt-0.5 p-2 rounded-lg bg-[var(--c-accent-subtle)] text-[var(--c-accent)] shrink-0">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0v-1.5m13.5 1.5v-1.5m0-10.5a3 3 0 00-3-3H9.75a3 3 0 00-3 3m9.75 0a3 3 0 01-3 3h-3a3 3 0 01-3-3m9.75 0H4.5m15 0h.008v.008H19.5v-.008z"/>
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-medium text-sm text-[var(--c-text-1)] font-mono">{{ d.device }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--c-surface-deep)] text-[var(--c-text-3)] font-mono uppercase">{{ d.fsType }}</span>
              </div>
              <div class="text-xs text-[var(--c-text-3)] mt-0.5 font-mono">{{ d.mountPoint }}</div>
            </div>
            <div class="text-right shrink-0">
              <div class="text-sm font-medium text-[var(--c-text-1)]">{{ fmtBytes(d.used) }}</div>
              <div class="text-[11px] text-[var(--c-text-3)]">of {{ fmtBytes(d.total) }}</div>
            </div>
          </div>

          <!-- Usage bar -->
          <div class="space-y-1.5">
            <div class="w-full h-2 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all"
                :class="usedPct(d) > 90 ? 'bg-[var(--c-danger)]' : usedPct(d) > 75 ? 'bg-[var(--c-warning)]' : 'bg-[var(--c-accent)]'"
                :style="{ width: usedPct(d) + '%' }"
              />
            </div>
            <div class="flex justify-between text-[11px] text-[var(--c-text-3)]">
              <span>{{ fmtBytes(d.free) }} free</span>
              <span>{{ usedPct(d).toFixed(1) }}% used</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ── RAID Arrays ─────────────────────────────────────────────────── -->
      <template v-if="raids.length > 0">
        <h3 class="text-sm font-semibold text-[var(--c-text-2)] uppercase tracking-widest mb-3">RAID Arrays</h3>
        <div class="space-y-3">
          <div
            v-for="r in raids"
            :key="r.name"
            class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] p-4"
          >
            <div class="flex items-center gap-3 mb-3">
              <div class="p-2 rounded-lg shrink-0"
                :class="r.active === r.total && r.state === 'active'
                  ? 'bg-green-500/10 text-green-500'
                  : 'bg-[var(--c-danger)]/10 text-[var(--c-danger)]'">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
                </svg>
              </div>
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-sm text-[var(--c-text-1)] font-mono">/dev/{{ r.name }}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--c-surface-deep)] text-[var(--c-text-3)] uppercase font-medium">{{ raidLevelLabel(r.level) }}</span>
                  <span
                    class="text-[10px] px-1.5 py-0.5 rounded font-medium"
                    :class="r.state === 'active' && r.active === r.total
                      ? 'bg-green-500/10 text-green-600'
                      : 'bg-[var(--c-danger)]/10 text-[var(--c-danger)]'"
                  >{{ r.state === 'active' && r.active === r.total ? 'Healthy' : r.state }}</span>
                </div>
                <div class="text-xs text-[var(--c-text-3)] mt-0.5">
                  {{ r.active }}/{{ r.total }} devices active
                </div>
              </div>
            </div>

            <!-- Member devices -->
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="dev in r.devices"
                :key="dev"
                class="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-md bg-[var(--c-surface-deep)] text-[var(--c-text-2)]"
              >
                <span class="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                /dev/{{ dev }}
              </span>
            </div>
          </div>
        </div>
      </template>

    </template>
  </div>
</template>
