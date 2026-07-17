<script setup lang="ts">
import { ref, computed } from 'vue'
import { useUploads, type Transfer, type TransferStatus } from '../../lib/uploads'

const uploads = useUploads()
const collapsed = ref(false)

// Non-terminal — still doing (or about to do) something.
const ACTIVE: TransferStatus[] = ['uploading', 'running', 'paused', 'queued']
// Done, one way or another — safe to dismiss.
const TERMINAL: TransferStatus[] = ['done', 'cancelled', 'error']
// Pause/resume + cancel both make sense on these.
const PAUSABLE: TransferStatus[] = ['uploading', 'running', 'paused']

const activeCount = computed(() => uploads.tasks.value.filter(t => ACTIVE.includes(t.status)).length)
const hasTerminal = computed(() => uploads.tasks.value.some(t => TERMINAL.includes(t.status)))

// Newest first — a fresh array, never touches the reactive `tasks` in place.
const reversedTasks = computed(() => [...uploads.tasks.value].reverse())

// Overall mini bar: byte-weighted average across active transfers that report
// a total size (uploads). null → nothing determinate to show (e.g. only
// copy/move jobs running), which renders as an indeterminate pulse instead.
const overallPct = computed<number | null>(() => {
  const withSize = uploads.tasks.value.filter(
    t => ACTIVE.includes(t.status) && typeof t.totalBytes === 'number' && t.totalBytes > 0
  )
  if (!withSize.length) return null
  const total = withSize.reduce((s, t) => s + (t.totalBytes ?? 0), 0)
  const sent  = withSize.reduce((s, t) => s + (t.sentBytes ?? 0), 0)
  return total > 0 ? Math.round((sent / total) * 100) : 0
})

function pct(t: Transfer): number {
  if (t.totalBytes) return Math.round(((t.sentBytes ?? 0) / t.totalBytes) * 100)
  if (t.totalChunks) return Math.round(((t.sentChunks ?? 0) / t.totalChunks) * 100)
  return 0
}

function speed(bps: number): string {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`
  if (bps >= 1_024)     return `${(bps / 1_024).toFixed(0)} KB/s`
  return bps > 0 ? `${Math.round(bps)} B/s` : ''
}

function statusLabel(t: Transfer): string {
  switch (t.status) {
    case 'uploading':  return pct(t) + '%'
    case 'running':    return 'en cours'
    case 'paused':     return 'en pause'
    case 'queued':     return 'en attente'
    case 'error':      return 'erreur'
    case 'done':       return 'terminé'
    case 'cancelled':  return 'annulé'
    default:           return t.status
  }
}

function statusTextClass(t: Transfer): string {
  switch (t.status) {
    case 'done':      return 'text-success'
    case 'error':     return 'text-danger'
    case 'cancelled': return 'text-[var(--c-text-3)]'
    case 'paused':    return 'text-[var(--c-warning)]'
    default:          return 'text-[var(--c-text-3)]'
  }
}

function iconClass(t: Transfer): string {
  switch (t.status) {
    case 'done':      return 'bg-success/10 text-success'
    case 'error':     return 'bg-danger/10 text-danger'
    case 'cancelled': return 'bg-[var(--c-surface-deep)] text-[var(--c-text-3)]'
    case 'paused':    return 'bg-[var(--c-warning)]/10 text-[var(--c-warning)]'
    default:          return 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
  }
}

function canPauseResume(t: Transfer) { return PAUSABLE.includes(t.status) }
function canCancel(t: Transfer)      { return PAUSABLE.includes(t.status) }
function canRetry(t: Transfer)       { return t.status === 'error' || t.interrupted === true }
function canRemove(t: Transfer)      { return TERMINAL.includes(t.status) }

function togglePause(t: Transfer) {
  if (t.status === 'paused') uploads.resume(t.id)
  else uploads.pause(t.id)
}

function clearFinished() {
  for (const t of uploads.tasks.value.filter(t => TERMINAL.includes(t.status))) {
    uploads.remove(t.id)
  }
}
</script>

<template>
  <div
    v-if="uploads.tasks.value.length > 0"
    class="shrink-0 border-t border-[var(--c-border)] bg-[var(--c-surface-alt)]"
  >
    <!-- Header -->
    <div class="flex items-center gap-3 px-3.5 py-2">
      <button
        @click="collapsed = !collapsed"
        class="flex items-center gap-1.5 text-xs font-medium text-[var(--c-text-2)] hover:text-[var(--c-text-1)] transition-colors shrink-0"
      >
        <svg class="w-3 h-3 transition-transform" :class="collapsed ? '-rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
        Transferts — {{ activeCount }} actif{{ activeCount === 1 ? '' : 's' }}
      </button>

      <!-- Mini overall progress bar -->
      <div v-if="activeCount > 0" class="flex-1 h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
        <div v-if="overallPct !== null" class="h-full bg-[var(--c-accent)] rounded-full transition-all" :style="{ width: overallPct + '%' }" />
        <div v-else class="h-full w-1/3 bg-[var(--c-accent)] rounded-full animate-[tray-slide_1.2s_ease-in-out_infinite]" />
      </div>
      <div v-else class="flex-1" />

      <button
        v-if="hasTerminal"
        @click="clearFinished"
        class="text-[10px] text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors uppercase tracking-wide shrink-0"
      >
        Effacer terminés
      </button>
    </div>

    <!-- Body -->
    <div v-if="!collapsed" class="max-h-56 overflow-y-auto border-t border-[var(--c-border)] divide-y divide-[var(--c-border)]">
      <div v-for="t in reversedTasks" :key="t.id" class="px-3.5 py-2.5">
        <div class="flex items-center gap-2.5 min-w-0">
          <!-- Icon -->
          <div class="shrink-0 w-6 h-6 rounded-md flex items-center justify-center" :class="iconClass(t)">
            <svg v-if="t.status === 'done'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            <svg v-else-if="t.status === 'error'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
            <svg v-else-if="t.kind === 'copy'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
            </svg>
            <svg v-else-if="t.kind === 'move'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3"/>
            </svg>
            <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
          </div>

          <!-- Name + status + progress -->
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-xs text-[var(--c-text-1)] truncate" :title="t.name">{{ t.name }}</span>
              <span class="text-[10px] tabular-nums shrink-0" :class="statusTextClass(t)">{{ statusLabel(t) }}</span>
            </div>

            <!-- Determinate bar (uploads: sentBytes/totalBytes) -->
            <div v-if="t.kind === 'upload' && (t.status === 'uploading' || t.status === 'paused')"
              class="mt-1.5 h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
              <div class="h-full rounded-full transition-all"
                :class="t.status === 'paused' ? 'bg-[var(--c-warning)]' : 'bg-[var(--c-accent)]'"
                :style="{ width: pct(t) + '%' }" />
            </div>

            <!-- Indeterminate bar (copy/move in progress) -->
            <div v-else-if="t.kind !== 'upload' && t.status === 'running'"
              class="mt-1.5 h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
              <div class="h-full w-1/3 bg-[var(--c-accent)] rounded-full animate-[tray-slide_1.2s_ease-in-out_infinite]" />
            </div>

            <!-- Speed (uploads only) -->
            <div v-if="t.kind === 'upload' && t.status === 'uploading' && (t.bytesPerSec ?? 0) > 0"
              class="text-[10px] text-[var(--c-text-3)] mt-0.5 tabular-nums">
              {{ speed(t.bytesPerSec ?? 0) }}
            </div>

            <!-- Full error, never truncated -->
            <div v-if="t.status === 'error' && t.error" class="text-[10px] text-danger mt-1 whitespace-pre-wrap break-words">
              {{ t.error }}
            </div>
          </div>

          <!-- Actions -->
          <div class="flex gap-0.5 shrink-0">
            <button v-if="canPauseResume(t)" @click="togglePause(t)" :title="t.status === 'paused' ? 'Reprendre' : 'Pause'"
              class="p-1 rounded-sm text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
              <svg v-if="t.status === 'paused'" class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z"/>
              </svg>
              <svg v-else class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
              </svg>
            </button>
            <button v-if="canCancel(t)" @click="uploads.cancel(t.id)" title="Annuler"
              class="p-1 rounded-sm text-[var(--c-text-3)] hover:text-danger hover:bg-danger/10 transition-colors">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <rect x="4" y="4" width="16" height="16" rx="2"/>
              </svg>
            </button>
            <button v-if="canRetry(t)" @click="uploads.retry(t.id)"
              class="px-1.5 py-0.5 rounded-sm text-[10px] font-medium text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] transition-colors">
              Réessayer
            </button>
            <button v-if="canRemove(t)" @click="uploads.remove(t.id)" title="Effacer"
              class="p-1 rounded-sm text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<!-- Non-scoped: the keyframe name must stay un-mangled so the Tailwind arbitrary
     class `animate-[tray-slide_…]` (emitted globally) can resolve it. -->
<style>
@keyframes tray-slide {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
</style>
