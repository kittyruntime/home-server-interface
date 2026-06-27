<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
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
  if (n <= 0)         return '0 B'
  if (n < 1024)       return `${n} B`
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3)  return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n < 1024 ** 4)  return `${(n / 1024 ** 3).toFixed(2)} GB`
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

function raidDescription(level: string): string {
  const map: Record<string, string> = {
    raid0: 'Striping — no redundancy, max throughput',
    raid1: 'Mirroring — 1 drive fault tolerance',
    raid5: 'Parity striping — 1 drive fault tolerance',
    raid6: 'Double parity — 2 drive fault tolerance',
    raid10: 'Mirror + stripe — high performance & redundancy',
    linear: 'Linear concatenation',
  }
  return map[level] ?? ''
}

function diskForRaid(raidName: string): DiskInfo | undefined {
  return disks.value.find(d => d.device === `/dev/${raidName}` || d.device.endsWith(`/${raidName}`))
}

function isHealthy(r: RaidArray): boolean {
  return r.state === 'active' && r.active === r.total
}

const raidMemberDevices = computed<Set<string>>(() => {
  const s = new Set<string>()
  raids.value.forEach(r => r.devices.forEach(d => s.add(d)))
  return s
})

const standaloneDisks = computed<DiskInfo[]>(() =>
  disks.value.filter(d => {
    const dev = d.device.replace('/dev/', '')
    if (dev.startsWith('md')) return false
    if (raidMemberDevices.value.has(dev)) return false
    return true
  })
)
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-[var(--c-text-1)] mb-1">Storage &amp; Disks</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">Mounted filesystems and RAID arrays on this host.</p>

    <div v-if="loading" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm">
      <LoadingSpinner /> Loading…
    </div>
    <div v-else-if="error" class="text-sm text-red-400">{{ error }}</div>

    <template v-else>

      <!-- ── RAID Arrays ───────────────────────────────────────────────── -->
      <template v-if="raids.length > 0">
        <div class="flex items-center gap-2 mb-4">
          <svg class="w-3.5 h-3.5 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
          </svg>
          <h3 class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Software RAID</h3>
        </div>

        <div class="space-y-5 mb-8">
          <div
            v-for="r in raids"
            :key="r.name"
            class="rounded-xl border overflow-hidden bg-[var(--c-surface)]"
            :class="isHealthy(r) ? 'border-[var(--c-border)]' : 'border-red-500/30'"
          >
            <!-- ── Header ── -->
            <div class="flex items-center gap-3 px-4 pt-4 pb-2">
              <!-- Level badge -->
              <span
                class="text-[11px] font-bold px-2.5 py-1 rounded-md tracking-wide"
                :class="isHealthy(r)
                  ? 'bg-[var(--c-accent)]/15 text-[var(--c-accent)]'
                  : 'bg-red-500/10 text-red-400'"
              >{{ raidLevelLabel(r.level) }}</span>

              <span class="font-mono text-sm text-[var(--c-text-1)]">/dev/{{ r.name }}</span>

              <div class="ml-auto flex items-center gap-2.5">
                <span class="text-xs text-[var(--c-text-3)]">{{ r.active }}/{{ r.total }}</span>
                <span
                  class="inline-flex items-center gap-1.5 text-xs font-medium"
                  :class="isHealthy(r) ? 'text-green-400' : 'text-red-400'"
                >
                  <span
                    class="w-1.5 h-1.5 rounded-full"
                    :class="isHealthy(r) ? 'bg-green-400' : 'bg-red-400'"
                  />
                  {{ isHealthy(r) ? 'Healthy' : r.state }}
                </span>
              </div>
            </div>

            <p v-if="raidDescription(r.level)" class="text-[11px] text-[var(--c-text-3)] px-4 pb-4">
              {{ raidDescription(r.level) }}
            </p>

            <!-- ── Drive bay ── -->
            <div class="px-4 pb-5">
              <div class="flex items-center gap-1.5 flex-wrap">

                <!-- Each physical drive -->
                <template v-for="(dev, idx) in r.devices" :key="dev">
                  <div class="flex flex-col items-center gap-2">
                    <!-- Drive illustration -->
                    <div
                      class="relative rounded-lg border transition-colors"
                      :class="idx < r.active
                        ? 'border-[var(--c-border-strong)] bg-[var(--c-surface-deep)]'
                        : 'border-red-500/40 bg-red-500/5'"
                    >
                      <svg viewBox="0 0 52 68" class="w-14 h-[4.5rem]">
                        <!-- Body -->
                        <rect x="3" y="3" width="46" height="62" rx="5"
                          :fill="idx < r.active ? 'var(--c-surface-deep)' : 'rgba(239,68,68,0.06)'"
                          :stroke="idx < r.active ? 'var(--c-border-strong)' : 'rgba(239,68,68,0.5)'"
                          stroke-width="1.5"
                        />
                        <!-- Mounting holes -->
                        <circle cx="9"  cy="10" r="2.5" fill="var(--c-surface)" opacity="0.8"/>
                        <circle cx="43" cy="10" r="2.5" fill="var(--c-surface)" opacity="0.8"/>
                        <circle cx="9"  cy="58" r="2.5" fill="var(--c-surface)" opacity="0.8"/>
                        <circle cx="43" cy="58" r="2.5" fill="var(--c-surface)" opacity="0.8"/>
                        <!-- Platter outer ring -->
                        <circle cx="26" cy="32" r="13"
                          fill="none"
                          :stroke="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.5)'"
                          stroke-width="1" opacity="0.35"
                        />
                        <!-- Platter inner ring -->
                        <circle cx="26" cy="32" r="7"
                          fill="none"
                          :stroke="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.5)'"
                          stroke-width="1" opacity="0.35"
                        />
                        <!-- Arm -->
                        <line x1="26" y1="32" x2="35" y2="21"
                          :stroke="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.6)'"
                          stroke-width="1.5" opacity="0.5" stroke-linecap="round"
                        />
                        <!-- Spindle -->
                        <circle cx="26" cy="32" r="2.5"
                          :fill="idx < r.active ? 'var(--c-accent)' : 'rgba(239,68,68,0.7)'"
                          opacity="0.8"
                        />
                        <!-- Activity LED -->
                        <circle cx="40" cy="50" r="2.5"
                          :fill="idx < r.active ? '#4ade80' : '#ef4444'"
                          opacity="0.9"
                        />
                        <!-- SATA connector strip -->
                        <rect x="15" y="60" width="22" height="3" rx="1"
                          fill="var(--c-text-3)" opacity="0.25"
                        />
                      </svg>
                    </div>
                    <!-- Device name -->
                    <span
                      class="text-[10px] font-mono"
                      :class="idx < r.active ? 'text-[var(--c-text-3)]' : 'text-red-400'"
                    >/dev/{{ dev }}</span>
                  </div>

                  <!-- Arrow between drives (not after last) -->
                  <svg
                    v-if="idx < r.devices.length - 1"
                    class="w-4 h-4 text-[var(--c-text-3)] self-center mb-5 shrink-0"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                  </svg>
                </template>

                <!-- Logical result arrow -->
                <div class="flex items-center self-center mb-5 gap-2 ml-1">
                  <svg class="w-4 h-4 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                  </svg>
                  <div>
                    <div class="text-[11px] font-semibold text-[var(--c-text-2)]">{{ raidLevelLabel(r.level) }}</div>
                    <div v-if="diskForRaid(r.name)" class="text-[10px] text-[var(--c-text-3)] font-mono">
                      {{ diskForRaid(r.name)!.mountPoint }}
                    </div>
                    <div v-else class="text-[10px] text-[var(--c-text-3)]">not mounted</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- ── Usage bar (if mounted) ── -->
            <template v-if="diskForRaid(r.name)">
              <div class="border-t border-[var(--c-border)] px-4 py-3">
                <div class="flex justify-between items-baseline mb-2">
                  <span class="text-[11px] font-mono text-[var(--c-text-3)]">{{ diskForRaid(r.name)!.mountPoint }}</span>
                  <div>
                    <span class="text-sm font-medium text-[var(--c-text-1)]">{{ fmtBytes(diskForRaid(r.name)!.used) }}</span>
                    <span class="text-xs text-[var(--c-text-3)]"> / {{ fmtBytes(diskForRaid(r.name)!.total) }}</span>
                  </div>
                </div>
                <div class="w-full h-1.5 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all"
                    :class="usedPct(diskForRaid(r.name)!) > 90 ? 'bg-red-500' : usedPct(diskForRaid(r.name)!) > 75 ? 'bg-yellow-500' : 'bg-[var(--c-accent)]'"
                    :style="{ width: usedPct(diskForRaid(r.name)!) + '%' }"
                  />
                </div>
                <div class="flex justify-between text-[11px] text-[var(--c-text-3)] mt-1.5">
                  <span>{{ fmtBytes(diskForRaid(r.name)!.free) }} free</span>
                  <span>{{ usedPct(diskForRaid(r.name)!).toFixed(1) }}%</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </template>

      <!-- ── Standalone disks ──────────────────────────────────────────── -->
      <template v-if="standaloneDisks.length > 0">
        <div class="flex items-center gap-2 mb-4">
          <svg class="w-3.5 h-3.5 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0v-1.5m13.5 1.5v-1.5m0-10.5a3 3 0 00-3-3H9.75a3 3 0 00-3 3m9.75 0a3 3 0 01-3 3h-3a3 3 0 01-3-3m9.75 0H4.5m15 0h.008v.008H19.5v-.008z"/>
          </svg>
          <h3 class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">
            {{ raids.length > 0 ? 'Other Disks' : 'Disks' }}
          </h3>
        </div>

        <div class="space-y-3">
          <div
            v-for="d in standaloneDisks"
            :key="d.device + d.mountPoint"
            class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] p-4 space-y-3"
          >
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
            <div class="space-y-1.5">
              <div class="w-full h-1.5 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full transition-all"
                  :class="usedPct(d) > 90 ? 'bg-red-500' : usedPct(d) > 75 ? 'bg-yellow-500' : 'bg-[var(--c-accent)]'"
                  :style="{ width: usedPct(d) + '%' }"
                />
              </div>
              <div class="flex justify-between text-[11px] text-[var(--c-text-3)]">
                <span>{{ fmtBytes(d.free) }} free</span>
                <span>{{ usedPct(d).toFixed(1) }}%</span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div v-if="disks.length === 0 && raids.length === 0" class="text-sm text-[var(--c-text-3)]">
        No mounted block devices found.
      </div>

    </template>
  </div>
</template>
