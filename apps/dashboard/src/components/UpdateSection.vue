<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../lib/trpc'
import LoadingSpinner from './ui/LoadingSpinner.vue'

type Status = Awaited<ReturnType<typeof trpc.update.status.query>>

const status   = ref<Status | null>(null)
const loading  = ref(true)
const applying = ref(false)
const checking = ref(false)
const error    = ref<string | null>(null)
const restarting = ref(false)

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
    restarting.value = true
    pollRestart()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to schedule update'
    applying.value = false
  }
}

function pollRestart() {
  let serverWentDown = false
  const interval = setInterval(async () => {
    try {
      await fetch('/health')
      if (serverWentDown) {
        clearInterval(interval)
        window.location.reload()
      }
    } catch {
      serverWentDown = true
    }
  }, 3000)
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(iso))
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

    <!-- Restarting state -->
    <div v-if="restarting" class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] p-5">
      <div class="flex items-center gap-3">
        <LoadingSpinner label="Restarting" />
        <div>
          <p class="text-sm font-medium text-[var(--c-text-1)]">Update in progress</p>
          <p class="text-xs text-[var(--c-text-3)] mt-0.5">The server is restarting. The page will reload automatically.</p>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-else-if="loading" class="space-y-3">
      <div class="h-4 bg-[var(--c-hover)] rounded animate-pulse w-40" />
      <div class="h-4 bg-[var(--c-hover)] rounded animate-pulse w-64" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="text-sm text-[var(--c-accent)]">{{ error }}</div>

    <!-- Status card -->
    <div v-else-if="status" class="space-y-4">

      <!-- Update available banner -->
      <div
        v-if="status.hasUpdate"
        class="rounded-xl border border-[var(--c-accent)]/30 bg-[var(--c-accent)]/5 p-4 flex items-start justify-between gap-4"
      >
        <div class="flex items-start gap-3 min-w-0">
          <div class="w-8 h-8 rounded-lg bg-[var(--c-accent)]/15 flex items-center justify-center shrink-0 mt-0.5">
            <svg class="w-4 h-4 text-[var(--c-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
          </div>
          <div>
            <p class="text-sm font-medium text-[var(--c-text-1)]">
              Version {{ status.latest }} available
            </p>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">
              You are on {{ status.current }}.
              The server will restart after installation.
            </p>
          </div>
        </div>
        <button
          @click="applyUpdate"
          :disabled="applying || status.pending"
          class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-[var(--c-accent)] text-[var(--c-accent-fg)] text-xs font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg v-if="applying || status.pending" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
          {{ applying || status.pending ? 'Scheduling…' : 'Install' }}
        </button>
      </div>

      <!-- Up to date -->
      <div
        v-else
        class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] p-4 flex items-center gap-3"
      >
        <div class="w-8 h-8 rounded-lg bg-[var(--c-success)]/10 flex items-center justify-center shrink-0">
          <svg class="w-4 h-4 text-[var(--c-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
        </div>
        <div>
          <p class="text-sm font-medium text-[var(--c-text-1)]">Up to date</p>
          <p class="text-xs text-[var(--c-text-3)] mt-0.5">Running version {{ status.current }}</p>
        </div>
      </div>

      <!-- Meta + manual check -->
      <div class="flex items-center justify-between gap-4">
        <p class="text-xs text-[var(--c-text-3)]">
          <template v-if="status.checkedAt">Last checked: {{ formatDate(status.checkedAt) }}</template>
          <template v-else>Never checked — check runs daily via systemd timer.</template>
        </p>
        <button
          @click="checkNow"
          :disabled="checking || applying || status.pending"
          class="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--c-border)] text-xs text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg
            class="w-3.5 h-3.5"
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
