<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../lib/trpc'
import ReleaseNotes from './ReleaseNotes.vue'

type Status = Awaited<ReturnType<typeof trpc.update.status.query>>

const status   = ref<Status | null>(null)
const loading  = ref(true)
const applying = ref(false)
const checking = ref(false)
const error    = ref<string | null>(null)

type RestartStep = 'scheduled' | 'restarting' | 'reconnecting' | 'done'
const restartStep     = ref<RestartStep | null>(null)
const reloadCountdown = ref(3)

async function fetchStatus() {
  try {
    status.value = await trpc.update.status.query()
    error.value = null
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to fetch update status'
  } finally {
    loading.value = false
  }
}

async function checkNow() {
  checking.value = true
  error.value = null
  try {
    await trpc.update.check.mutate()
    await fetchStatus()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to check for updates'
  } finally {
    checking.value = false
  }
}

async function applyUpdate() {
  if (!status.value?.latest) return
  applying.value = true
  error.value = null
  try {
    await trpc.update.apply.mutate({ version: status.value.latest })
    restartStep.value = 'scheduled'
    setTimeout(() => {
      restartStep.value = 'restarting'
      pollRestart()
    }, 1000)
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to schedule update'
    applying.value = false
  }
}

function pollRestart() {
  let serverWentDown = false
  const interval = setInterval(async () => {
    try {
      const res = await fetch('/health')
      if (!res.ok) throw new Error('not ok')
      if (serverWentDown) {
        clearInterval(interval)
        restartStep.value = 'done'
        startReloadCountdown()
      }
    } catch {
      if (!serverWentDown) {
        serverWentDown = true
        restartStep.value = 'reconnecting'
      }
    }
  }, 2000)
}

function startReloadCountdown() {
  reloadCountdown.value = 3
  const t = setInterval(() => {
    reloadCountdown.value--
    if (reloadCountdown.value <= 0) {
      clearInterval(t)
      window.location.reload()
    }
  }, 1000)
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(iso))
}

const STEPS: { key: RestartStep; label: string }[] = [
  { key: 'scheduled',   label: 'Update scheduled' },
  { key: 'restarting',  label: 'Server restarting' },
  { key: 'reconnecting', label: 'Reconnecting' },
  { key: 'done',        label: 'Ready' },
]

const STEP_ORDER: RestartStep[] = ['scheduled', 'restarting', 'reconnecting', 'done']

function stepState(key: RestartStep): 'done' | 'active' | 'pending' {
  const current = restartStep.value
  if (!current) return 'pending'
  const ci = STEP_ORDER.indexOf(current)
  const ki = STEP_ORDER.indexOf(key)
  if (ki < ci) return 'done'
  if (ki === ci) return 'active'
  return 'pending'
}

let timer: ReturnType<typeof setInterval>

onMounted(() => {
  fetchStatus()
  timer = setInterval(fetchStatus, 60_000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div>
    <h2 class="text-base font-semibold text-[var(--c-text-1)] mb-1">Updates</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">Manage software updates for this server.</p>

    <!-- ── Restart timeline ─────────────────────────────────────────────── -->
    <div v-if="restartStep" class="space-y-6">
      <div class="panel-card p-6">
        <p class="eyebrow mb-6">Installing update</p>
        <div class="space-y-5">
          <div v-for="step in STEPS" :key="step.key" class="flex items-center gap-3">
            <!-- Icon -->
            <div
              :class="[
                'w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                stepState(step.key) === 'done'   ? 'bg-[var(--c-success)]/15 text-[var(--c-success)]' :
                stepState(step.key) === 'active' ? 'bg-[var(--c-accent)]/10 text-[var(--c-accent)]'   :
                'bg-[var(--c-hover)] text-[var(--c-text-3)]'
              ]"
            >
              <!-- Done -->
              <svg v-if="stepState(step.key) === 'done'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
              </svg>
              <!-- Active spinning -->
              <svg v-else-if="stepState(step.key) === 'active'" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              <!-- Pending dot -->
              <span v-else class="w-1.5 h-1.5 rounded-full bg-current" />
            </div>
            <!-- Label -->
            <span
              :class="[
                'text-sm transition-colors',
                stepState(step.key) === 'done'   ? 'text-[var(--c-text-2)]' :
                stepState(step.key) === 'active' ? 'text-[var(--c-text-1)] font-medium' :
                'text-[var(--c-text-3)]'
              ]"
            >{{ step.label }}</span>
            <!-- Countdown on done -->
            <span v-if="step.key === 'done' && restartStep === 'done'" class="ml-auto text-xs text-[var(--c-text-3)] font-mono">
              reloading in {{ reloadCountdown }}…
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Loading skeleton ─────────────────────────────────────────────── -->
    <div v-else-if="loading" class="space-y-3">
      <div class="h-4 bg-[var(--c-hover)] rounded-sm animate-pulse w-40" />
      <div class="h-4 bg-[var(--c-hover)] rounded-sm animate-pulse w-64" />
    </div>

    <!-- ── Error ────────────────────────────────────────────────────────── -->
    <p v-else-if="error" class="text-sm text-[var(--c-accent)]">{{ error }}</p>

    <!-- ── Main content ─────────────────────────────────────────────────── -->
    <div v-else-if="status" class="space-y-5">

      <!-- Version row -->
      <div class="panel-card p-5 flex items-center justify-between gap-6">
        <div>
          <p class="eyebrow mb-1">Current version</p>
          <p class="font-mono text-xl text-[var(--c-text-1)]">{{ status.current }}</p>
        </div>
        <template v-if="status.hasUpdate">
          <svg class="w-4 h-4 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3"/>
          </svg>
          <div class="text-right">
            <p class="eyebrow mb-1">Available</p>
            <p class="font-mono text-xl text-[var(--c-accent)]">{{ status.latest }}</p>
          </div>
        </template>
        <template v-else>
          <div class="flex items-center gap-2 text-[var(--c-success)]">
            <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            <span class="text-sm">Up to date</span>
          </div>
        </template>
      </div>

      <!-- Release notes -->
      <div v-if="status.hasUpdate && status.releaseNotes" class="panel-card overflow-hidden">
        <div class="px-4 py-3 border-b border-[var(--c-border)] flex items-center justify-between gap-3">
          <p class="eyebrow">What's new in {{ status.latest }}</p>
          <a
            :href="`${status.repoUrl}/releases/tag/${status.latest}`"
            target="_blank" rel="noopener noreferrer"
            class="text-xs text-[var(--c-accent)] hover:underline inline-flex items-center gap-1 shrink-0"
          >
            View on GitHub
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14 5h5m0 0v5m0-5L10 14M9 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-3"/>
            </svg>
          </a>
        </div>
        <div class="px-4 py-3 max-h-72 overflow-y-auto">
          <ReleaseNotes :source="status.releaseNotes" />
        </div>
      </div>

      <!-- Install CTA -->
      <div v-if="status.hasUpdate" class="flex items-center justify-between gap-4">
        <p class="text-xs text-[var(--c-text-3)]">The server will restart after installation (~30s downtime).</p>
        <button
          @click="applyUpdate"
          :disabled="applying || status.pending"
          class="btn btn-primary btn-sm shrink-0"
        >
          <svg v-if="applying || status.pending" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
          {{ applying || status.pending ? 'Scheduling…' : 'Install update' }}
        </button>
      </div>

      <!-- Footer: last checked + manual check -->
      <div class="flex items-center justify-between pt-1 border-t border-[var(--c-border)]">
        <div>
          <p class="text-xs text-[var(--c-text-3)]">
            <template v-if="status.checkedAt">Last checked {{ formatDate(status.checkedAt) }}</template>
            <template v-else>Never checked — runs daily via systemd timer</template>
          </p>
          <a
            :href="`${status.repoUrl}/releases`"
            target="_blank" rel="noopener noreferrer"
            class="text-xs text-[var(--c-accent)] hover:underline inline-flex items-center gap-1 mt-0.5"
          >
            View all releases on GitHub
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14 5h5m0 0v5m0-5L10 14M9 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-3"/>
            </svg>
          </a>
        </div>
        <button
          @click="checkNow"
          :disabled="checking || applying || !!status.pending"
          class="btn btn-outline btn-xs"
        >
          <svg
            class="w-3 h-3"
            :class="checking ? 'animate-spin' : ''"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          {{ checking ? 'Checking…' : 'Check now' }}
        </button>
      </div>

    </div>
  </div>
</template>
