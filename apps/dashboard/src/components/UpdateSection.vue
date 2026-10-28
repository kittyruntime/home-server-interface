<script setup lang="ts">
import { formatDateTime, formatDay } from '../lib/format-date'
import { lastResultText, lastResultIsProblem, previousVersionText, rollbackCommand } from '../lib/update-result'
import LoadingState from './ui/LoadingState.vue'
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../lib/trpc'
import ReleaseNotes from './ReleaseNotes.vue'
import { useConfirm } from '../lib/confirm'
import LoadingSpinner from './ui/LoadingSpinner.vue'
import { Button } from '@/components/ui/button'

type Status = Awaited<ReturnType<typeof trpc.update.status.query>>
type Preflight = Awaited<ReturnType<typeof trpc.update.preflight.query>>

const status   = ref<Status | null>(null)
const preflight = ref<Preflight | null>(null)
const preflightLoading = ref(false)
const loading  = ref(true)
const applying = ref(false)
const checking = ref(false)
const error    = ref<string | null>(null)
const restarting = ref(false)
const rebooting = ref(false)
const restartKind = ref<'update' | 'manual' | 'host'>('update')
const { confirm } = useConfirm()

type RestartStep = 'scheduled' | 'restarting' | 'reconnecting' | 'done'
const restartStep     = ref<RestartStep | null>(null)
const reloadCountdown = ref(3)

async function fetchStatus() {
  try {
    status.value = await trpc.update.status.query()
    error.value = null
    if (status.value.hasUpdate) fetchPreflight()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to fetch update status'
  } finally {
    loading.value = false
  }
}

async function fetchPreflight() {
  preflightLoading.value = true
  try {
    preflight.value = await trpc.update.preflight.query()
  } catch {
    preflight.value = null
  } finally {
    preflightLoading.value = false
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
    restartKind.value = 'update'
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

async function restartSoftware() {
  const accepted = await confirm(
    'Restart HSI now? The interface will be unavailable for a few seconds. Running file transfers and in-progress tasks may be interrupted.',
    { title: 'Restart HSI', confirmLabel: 'Restart now', danger: true },
  )
  if (!accepted) return
  restarting.value = true
  error.value = null
  restartKind.value = 'manual'
  try {
    await trpc.update.restart.mutate()
    restartStep.value = 'scheduled'
    setTimeout(() => {
      restartStep.value = 'restarting'
      pollRestart()
    }, 500)
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to restart HSI'
    restarting.value = false
  }
}

async function rebootHost() {
  const accepted = await confirm(
    'Reboot the entire server? HSI, containers, file shares, and every service on this machine will be temporarily unavailable. Running tasks may be interrupted.',
    { title: 'Reboot server', confirmLabel: 'Continue', danger: true },
  )
  if (!accepted) return
  const confirmed = await confirm(
    'Final confirmation: reboot the physical host now?',
    { title: 'Confirm server reboot', confirmLabel: 'Reboot server', danger: true },
  )
  if (!confirmed) return
  rebooting.value = true
  error.value = null
  restartKind.value = 'host'
  try {
    await trpc.update.rebootHost.mutate()
    restartStep.value = 'scheduled'
    setTimeout(() => {
      restartStep.value = 'restarting'
      pollRestart()
    }, 500)
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to reboot the server'
    rebooting.value = false
  }
}

function pollRestart() {
  let serverWentDown = false
  const interval = setInterval(async () => {
    try {
      const res = await fetch('/health', { signal: AbortSignal.timeout(1500) })
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


function stepLabel(key: RestartStep) {
  if (key === 'scheduled') return restartKind.value === 'update' ? 'Update scheduled' : restartKind.value === 'host' ? 'Server reboot requested' : 'Restart requested'
  if (key === 'restarting') return restartKind.value === 'update' ? 'Installing and restarting' : restartKind.value === 'host' ? 'Server rebooting' : 'HSI restarting'
  if (key === 'reconnecting') return 'Reconnecting'
  return 'Ready'
}

const STEPS: RestartStep[] = ['scheduled', 'restarting', 'reconnecting', 'done']

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
    <h2 class="text-lg font-semibold text-foreground mb-1">Updates</h2>
    <p class="text-sm text-muted-foreground mb-6">Manage software updates for this server.</p>

    <!-- ── Restart timeline ─────────────────────────────────────────────── -->
    <div v-if="restartStep" class="space-y-6">
      <div class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-6">
        <p class="eyebrow mb-6">{{ restartKind === 'update' ? 'Installing update' : restartKind === 'host' ? 'Rebooting server' : 'Restarting HSI' }}</p>
        <div class="space-y-5">
          <div v-for="step in STEPS" :key="step" class="flex items-center gap-3">
            <!-- Icon -->
            <div
              :class="[
                'w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                stepState(step) === 'done'   ? 'bg-success/15 text-success' :
                stepState(step) === 'active' ? 'bg-primary/10 text-primary'   :
                'bg-accent text-muted-foreground'
              ]"
            >
              <!-- Done -->
              <svg v-if="stepState(step) === 'done'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
              </svg>
              <!-- Active spinning -->
              <LoadingSpinner v-else-if="stepState(step) === 'active'" />
              <!-- Pending dot -->
              <span v-else class="w-1.5 h-1.5 rounded-full bg-current" />
            </div>
            <!-- Label -->
            <span
              :class="[
                'text-sm transition-colors',
                stepState(step) === 'done'   ? 'text-foreground/80' :
                stepState(step) === 'active' ? 'text-foreground font-medium' :
                'text-muted-foreground'
              ]"
            >{{ stepLabel(step) }}</span>
            <!-- Countdown on done -->
            <span v-if="step === 'done' && restartStep === 'done'" class="ml-auto text-xs text-muted-foreground font-mono">
              reloading in {{ reloadCountdown }}…
            </span>
          </div>
        </div>
      </div>
    </div>

    <LoadingState v-else-if="loading" variant="compact" />

    <!-- ── Error ────────────────────────────────────────────────────────── -->
    <div v-else-if="error" role="alert" class="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{{ error }}</div>

    <!-- ── Main content ─────────────────────────────────────────────────── -->
    <div v-else-if="status" class="space-y-5">

      <!-- Version row -->
      <div class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-5 flex items-center justify-between gap-6">
        <div>
          <p class="eyebrow mb-1">Current version</p>
          <p class="font-figure text-xl text-foreground">{{ status.current }}</p>
        </div>
        <template v-if="status.hasUpdate">
          <svg class="w-4 h-4 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3"/>
          </svg>
          <div class="text-right">
            <p class="eyebrow mb-1">Available</p>
            <p class="font-figure text-xl text-primary">{{ status.latest }}</p>
          </div>
        </template>
        <template v-else>
          <div class="flex items-center gap-2 text-success">
            <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            <span class="text-sm">Up to date</span>
          </div>
        </template>
      </div>

      <!-- Last update result and the version it left behind -->
      <div v-if="lastResultText(status.lastResult) || previousVersionText(status.rollbackTarget, status.current, formatDay)" class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-5 space-y-2">
        <p v-if="status.lastResult && lastResultText(status.lastResult)"
           :class="['text-sm', status.lastResult.status === 'partial' ? 'text-warning' : lastResultIsProblem(status.lastResult) ? 'text-destructive' : 'text-foreground/80']">
          {{ lastResultText(status.lastResult) }}
          <span class="text-xs text-muted-foreground">{{ formatDateTime(status.lastResult.at) }}</span>
        </p>
        <div v-if="status.lastResult?.skippedSettings?.length" class="space-y-2 text-sm text-warning">
          <p>The update is complete. These application settings were not carried over, so the applications may not behave as before. Fix each one, then restart the application. Running the update again will not restore them.</p>
          <ul class="list-disc pl-5 space-y-2">
            <li v-for="(item, index) in status.lastResult.skippedSettings" :key="index">
              <strong>{{ item.application }} ({{ item.setting }})</strong>: {{ item.reason }}.
              {{ item.remediation }}
            </li>
          </ul>
        </div>
        <p v-if="previousVersionText(status.rollbackTarget, status.current, formatDay)" class="text-sm text-foreground/80">
          {{ previousVersionText(status.rollbackTarget, status.current, formatDay) }}
          <code class="font-mono text-xs text-foreground">{{ rollbackCommand(status.rollbackCommand) }}</code>
        </p>
      </div>

      <!-- Release notes -->
      <div v-if="status.hasUpdate && status.releaseNotes" class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden overflow-hidden">
        <div class="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
          <p class="eyebrow">What's new in {{ status.latest }}</p>
          <a
            :href="`${status.repoUrl}/releases/tag/${status.latest}`"
            target="_blank" rel="noopener noreferrer"
            class="text-xs text-primary hover:underline inline-flex items-center gap-1 shrink-0"
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

      <!-- Pre-flight checks -->
      <div v-if="status.hasUpdate && preflight" class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden overflow-hidden">
        <div class="px-4 py-3 border-b border-border">
          <p class="eyebrow">Pre-flight checks</p>
        </div>
        <ul class="divide-y divide-border">
          <li v-for="c in preflight.checks" :key="c.id" class="px-4 py-2.5 flex items-center gap-3">
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="c.status === 'ok' ? 'bg-success' : c.status === 'warn' ? 'bg-warning' : 'bg-destructive'"
            />
            <span class="text-sm text-foreground flex-1 min-w-0">{{ c.label }}</span>
            <span v-if="c.detail" class="text-xs text-muted-foreground truncate">{{ c.detail }}</span>
          </li>
        </ul>
      </div>

      <!-- Install CTA -->
      <div v-if="status.hasUpdate" class="flex items-center justify-between gap-4">
        <p class="text-xs text-muted-foreground">
          <template v-if="preflight && !preflight.canApply">A pre-flight check is failing: resolve it before installing.</template>
          <template v-else>The server will restart after installation (~30s downtime).</template>
        </p>
        <Button size="sm"
          @click="applyUpdate"
          :disabled="applying || status.pending || (preflight ? !preflight.canApply : false)"
          class="shrink-0"
        >
          <LoadingSpinner v-if="applying || status.pending" />
          {{ applying || status.pending ? 'Scheduling…' : 'Install update' }}
        </Button>
      </div>

      <!-- Footer: last checked + manual check -->
      <div class="flex items-center justify-between pt-1 border-t border-border">
        <div>
          <p class="text-xs text-muted-foreground">
            <template v-if="status.checkedAt">Last checked {{ formatDateTime(status.checkedAt) }}</template>
            <template v-else>Never checked (runs daily via systemd timer)</template>
          </p>
          <a
            :href="`${status.repoUrl}/releases`"
            target="_blank" rel="noopener noreferrer"
            class="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-0.5"
          >
            View all releases on GitHub
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14 5h5m0 0v5m0-5L10 14M9 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-3"/>
            </svg>
          </a>
        </div>
        <Button variant="outline" size="xs"
          @click="checkNow"
          :disabled="checking || applying || !!status.pending"
        >
          <LoadingSpinner v-if="checking" />
          <svg
            v-else class="w-3 h-3"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          {{ checking ? 'Checking…' : 'Check now' }}
        </Button>
      </div>

      <div class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-sm font-medium text-foreground">Restart HSI</p>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">Restart the application backend without rebooting the host server.</p>
        </div>
        <Button variant="outline" size="sm"
          @click="restartSoftware"
          :disabled="restarting || applying || !!status.pending"
          class="shrink-0"
        >
          <LoadingSpinner v-if="restarting" />
          <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.93 4.93A10 10 0 102 12h3m-3 0V7m0 5h5"/>
          </svg>
          {{ restarting ? 'Restarting…' : 'Restart HSI' }}
        </Button>
      </div>

      <div class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-5 border-destructive/25 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-sm font-medium text-foreground">Reboot server</p>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">Restart the physical host and every service running on it.</p>
        </div>
        <Button variant="destructive" size="sm"
          @click="rebootHost"
          :disabled="rebooting || restarting || applying || !!status.pending"
          class="shrink-0"
        >
          <LoadingSpinner v-if="rebooting" />
          <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v9m6.36-6.36a9 9 0 11-12.72 0"/>
          </svg>
          {{ rebooting ? 'Rebooting…' : 'Reboot server' }}
        </Button>
      </div>

    </div>
  </div>
</template>
