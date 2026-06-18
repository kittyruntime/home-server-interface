<script setup lang="ts">
import { ref } from 'vue'
import { useUploads, type UploadTask } from '../lib/uploads'
import { useNotifications, type Notification } from '../lib/notifications'
import SegmentedBar from './ui/SegmentedBar.vue'

defineProps<{ open: boolean; pos: { bottom: number; left: number } }>()
defineEmits<{ close: [] }>()

const uploads = useUploads()
const { notifications, dismiss, dismissAll } = useNotifications()

// ── stat mode toggle ──────────────────────────────────────────────────────────
const statMode = ref<'throughput' | 'chunks'>('throughput')
function toggleStatMode() {
  statMode.value = statMode.value === 'throughput' ? 'chunks' : 'throughput'
}

function formatThroughput(bps: number): string {
  if (bps <= 0)          return '—'
  if (bps >= 1_048_576)  return `${(bps / 1_048_576).toFixed(1)} MB/s`
  if (bps >= 1_024)      return `${(bps / 1_024).toFixed(1)} KB/s`
  return `${Math.round(bps)} B/s`
}

// ── upload helpers ────────────────────────────────────────────────────────────
function togglePause(task: UploadTask) {
  if (task.status === 'uploading') uploads.pause(task.id)
  else if (task.status === 'paused') uploads.resume(task.id)
}

function progressPct(task: UploadTask): number {
  if (!task.totalChunks) return 0
  return Math.round((task.sentChunks / task.totalChunks) * 100)
}

function uploadStatusLabel(task: UploadTask): string {
  switch (task.status) {
    case 'uploading':  return `${progressPct(task)}%`
    case 'paused':     return 'Paused'
    case 'done':       return 'Done'
    case 'error':      return 'Failed'
    case 'cancelled':  return 'Cancelled'
  }
}

function uploadBarColor(status: UploadTask['status']): string {
  switch (status) {
    case 'done':      return 'var(--c-success)'
    case 'error':     return 'var(--c-accent)'
    case 'cancelled': return 'var(--c-text-3)'
    case 'paused':    return 'var(--c-warning)'
    default:          return 'var(--c-accent)'
  }
}

function uploadStatusColor(status: UploadTask['status']): string {
  switch (status) {
    case 'done':      return 'text-[var(--c-success)]'
    case 'error':     return 'text-[var(--c-accent)]'
    case 'cancelled': return 'text-[var(--c-text-3)]'
    case 'paused':    return 'text-[var(--c-warning)]'
    default:          return 'text-[var(--c-accent)]'
  }
}

// ── notification helpers ──────────────────────────────────────────────────────
function notifIcon(type: Notification['type']): string {
  switch (type) {
    case 'success':  return 'M5 13l4 4L19 7'
    case 'error':    return 'M6 18L18 6M6 6l12 12'
    case 'info':     return 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
    default:         return 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z'
  }
}

function notifIconColor(type: Notification['type']): string {
  switch (type) {
    case 'success':  return 'text-[var(--c-success)]'
    case 'error':    return 'text-[var(--c-accent)]'
    case 'info':     return 'text-[var(--c-info)]'
    default:         return 'text-[var(--c-text-3)]'
  }
}

function notifBorderColor(type: Notification['type']): string {
  switch (type) {
    case 'success':  return 'border-[var(--c-success)]/40'
    case 'error':    return 'border-[var(--c-accent)]/40'
    case 'info':     return 'border-[var(--c-border-strong)]'
    default:         return 'border-[var(--c-border-strong)]'
  }
}
</script>

<template>
  <Teleport to="body">
    <!-- Backdrop transparent pour fermer au clic extérieur -->
    <div
      v-if="open"
      class="fixed inset-0 z-40"
      @click="$emit('close')"
    />

    <!-- Panel -->
    <Transition name="nm">
      <div
        v-if="open"
        class="fixed z-50 w-80 max-w-[calc(100vw-1rem)] bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-xl flex flex-col overflow-hidden"
        :style="{
          bottom: pos.bottom + 'px',
          left:   pos.left + 'px',
          maxHeight: '500px',
        }"
        @click.stop
      >
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--c-border)] flex-shrink-0">
          <span class="text-sm font-semibold text-[var(--c-text-1)]">Activity</span>
          <button
            @click="$emit('close')"
            class="p-1 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Scrollable body -->
        <div class="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">

          <!-- Transfers -->
          <section v-if="uploads.tasks.value.length > 0">
            <div class="font-mono text-[10px] uppercase tracking-widest text-[var(--c-text-3)] px-1 mb-2 select-none">Transfers</div>
            <div class="flex flex-col gap-2">
              <div
                v-for="task in uploads.tasks.value"
                :key="task.id"
                class="bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl px-3 py-2.5"
              >
                <div class="flex items-center justify-between gap-2 mb-1.5">
                  <span class="text-xs text-[var(--c-text-2)] truncate min-w-0" :title="task.name">{{ task.name }}</span>
                  <span class="text-[10px] shrink-0 tabular-nums font-medium" :class="uploadStatusColor(task.status)">
                    {{ uploadStatusLabel(task) }}
                  </span>
                </div>
                <SegmentedBar
                  class="mb-2"
                  :percent="progressPct(task)"
                  :color="uploadBarColor(task.status)"
                  height="compact"
                />
                <div class="flex items-center justify-between">
                  <button
                    v-if="task.status === 'uploading' || task.status === 'paused'"
                    @click.stop="toggleStatMode()"
                    :title="statMode === 'throughput' ? 'Switch to chunks' : 'Switch to throughput'"
                    class="text-[10px] tabular-nums text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors cursor-pointer"
                  >
                    <template v-if="statMode === 'throughput' && task.status === 'uploading'">
                      {{ formatThroughput(task.bytesPerSec) }}
                    </template>
                    <template v-else>
                      {{ task.sentChunks }} / {{ task.totalChunks }} chunks
                    </template>
                  </button>
                  <span v-else class="text-[10px] text-[var(--c-text-3)] tabular-nums">
                    {{ task.sentChunks }} / {{ task.totalChunks }} chunks
                  </span>

                  <div v-if="task.status === 'uploading' || task.status === 'paused'" class="flex items-center gap-1">
                    <button
                      @click="togglePause(task)"
                      :title="task.status === 'uploading' ? 'Pause' : 'Resume'"
                      class="p-1 rounded text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
                    >
                      <svg v-if="task.status === 'uploading'" class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="6" y="4" width="4" height="16" rx="1"/>
                        <rect x="14" y="4" width="4" height="16" rx="1"/>
                      </svg>
                      <svg v-else class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z"/>
                      </svg>
                    </button>
                    <button
                      @click="uploads.cancel(task.id)"
                      title="Cancel"
                      class="p-1 rounded text-[var(--c-text-3)] hover:text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] transition-colors"
                    >
                      <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="4" y="4" width="16" height="16" rx="2"/>
                      </svg>
                    </button>
                  </div>

                  <span v-if="task.error" class="text-[10px] text-[var(--c-accent)] truncate max-w-[140px]" :title="task.error">
                    {{ task.error }}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <!-- Alerts -->
          <section v-if="notifications.length > 0">
            <div class="font-mono text-[10px] uppercase tracking-widest text-[var(--c-text-3)] px-1 mb-2 select-none">Alerts</div>
            <div class="flex flex-col gap-2">
              <div
                v-for="n in notifications"
                :key="n.id"
                class="bg-[var(--c-surface)] border rounded-xl px-3 py-2.5 flex items-start gap-2.5"
                :class="notifBorderColor(n.type)"
              >
                <div class="shrink-0 mt-0.5" :class="notifIconColor(n.type)">
                  <svg v-if="n.type === 'progress'" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" :d="notifIcon(n.type)"/>
                  </svg>
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-xs text-[var(--c-text-1)] leading-snug">{{ n.title }}</p>
                  <p v-if="n.detail" class="text-[10px] text-[var(--c-text-3)] mt-0.5 leading-snug truncate">{{ n.detail }}</p>
                  <SegmentedBar
                    v-if="n.progress != null"
                    class="mt-1.5"
                    :percent="n.progress >= 0 ? n.progress : 0"
                    :indeterminate="n.progress < 0"
                    color="var(--c-accent)"
                    height="compact"
                  />
                </div>
                <button
                  @click="dismiss(n.id)"
                  class="shrink-0 p-0.5 rounded text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors"
                >
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            </div>
          </section>

          <!-- Empty state -->
          <div
            v-if="uploads.tasks.value.length === 0 && notifications.length === 0"
            class="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--c-text-3)] select-none py-10"
          >
            <svg class="w-7 h-7 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.25">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
            <p class="text-sm">All clear</p>
          </div>
        </div>

        <!-- Footer -->
        <div v-if="notifications.length > 0" class="px-4 py-2.5 border-t border-[var(--c-border)] flex-shrink-0">
          <button
            @click="dismissAll()"
            class="text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors"
          >
            Clear all alerts
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.nm-enter-active,
.nm-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.nm-enter-from,
.nm-leave-to {
  opacity: 0;
  transform: translateX(-6px);
}
</style>
