<script setup lang="ts">
import { computed } from 'vue'
import { useUploads, type UploadTask } from '../lib/uploads'
import { useNotifications } from '../lib/notifications'

defineProps<{ open: boolean; pos: { bottom: number; left: number } }>()
defineEmits<{ close: [] }>()

const uploads = useUploads()
const { notifications, dismiss, dismissAll } = useNotifications()

// ── upload helpers ────────────────────────────────────────────────────────────
function pct(t: UploadTask) {
  return t.totalChunks ? Math.round(t.sentChunks / t.totalChunks * 100) : 0
}

function speed(bps: number) {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`
  if (bps >= 1_024)     return `${(bps / 1_024).toFixed(0)} KB/s`
  return bps > 0 ? `${Math.round(bps)} B/s` : ''
}

function togglePause(t: UploadTask) {
  if (t.status === 'paused') uploads.resume(t.id)
  else uploads.pause(t.id)
}

// ── combined list ─────────────────────────────────────────────────────────────
// Uploads and notifications rendered together; uploads first when active
const hasItems = computed(
  () => uploads.tasks.value.length > 0 || notifications.value.length > 0
)
const hasDismissible = computed(
  () => notifications.value.some(n => n.type !== 'progress')
)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-40" @click="$emit('close')" />

    <Transition name="nm">
      <div
        v-if="open"
        class="fixed z-50 w-72 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-xl overflow-hidden flex flex-col"
        :style="{ bottom: pos.bottom + 'px', left: pos.left + 'px', maxHeight: '420px' }"
        @click.stop
      >
        <!-- Header -->
        <div class="flex items-center justify-between px-3.5 py-2.5 border-b border-[var(--c-border)] shrink-0">
          <span class="text-xs font-semibold text-[var(--c-text-2)] uppercase tracking-wider">Activity</span>
          <button @click="$emit('close')" class="p-1 rounded-sm text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Task list -->
        <div class="flex-1 overflow-y-auto divide-y divide-[var(--c-border)]">

          <!-- ── Upload tasks ───────────────────────────────────────────── -->
          <div
            v-for="t in uploads.tasks.value"
            :key="t.id"
            class="px-3.5 py-2.5"
          >
            <div class="flex items-center gap-2.5 min-w-0">
              <!-- Icon -->
              <div class="shrink-0 w-6 h-6 rounded-md flex items-center justify-center"
                :class="t.status === 'done'      ? 'bg-success/10 text-success'
                      : t.status === 'error'     ? 'bg-danger/10 text-danger'
                      : t.status === 'cancelled' ? 'bg-[var(--c-surface-deep)] text-[var(--c-text-3)]'
                      : t.status === 'paused'    ? 'bg-[var(--c-warning)]/10 text-[var(--c-warning)]'
                      :                            'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'">
                <svg v-if="t.status === 'done'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                </svg>
                <svg v-else-if="t.status === 'error'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
                <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                </svg>
              </div>

              <!-- Name + status -->
              <div class="flex-1 min-w-0">
                <div class="flex items-baseline justify-between gap-2">
                  <span class="text-xs text-[var(--c-text-1)] truncate" :title="t.name">{{ t.name }}</span>
                  <span class="text-[10px] tabular-nums shrink-0"
                    :class="t.status === 'done'      ? 'text-success'
                          : t.status === 'error'     ? 'text-danger'
                          : t.status === 'cancelled' ? 'text-[var(--c-text-3)]'
                          : t.status === 'paused'    ? 'text-[var(--c-warning)]'
                          :                            'text-[var(--c-text-3)]'">
                    {{ t.status === 'uploading' ? pct(t) + '%' : t.status === 'paused' ? 'paused' : t.status }}
                  </span>
                </div>

                <!-- Progress bar -->
                <div v-if="t.status === 'uploading' || t.status === 'paused'" class="mt-1.5 h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                  <div class="h-full rounded-full transition-all"
                    :class="t.status === 'paused' ? 'bg-[var(--c-warning)]' : 'bg-[var(--c-accent)]'"
                    :style="{ width: pct(t) + '%' }" />
                </div>

                <!-- Speed + error -->
                <div v-if="t.status === 'uploading' && t.bytesPerSec > 0" class="text-[10px] text-[var(--c-text-3)] mt-0.5 tabular-nums">
                  {{ speed(t.bytesPerSec) }}
                </div>
                <div v-if="t.error" class="text-[10px] text-danger mt-0.5 truncate">{{ t.error }}</div>
              </div>

              <!-- Actions -->
              <div v-if="t.status === 'uploading' || t.status === 'paused'" class="flex gap-0.5 shrink-0">
                <button @click="togglePause(t)" :title="t.status === 'paused' ? 'Resume' : 'Pause'"
                  class="p-1 rounded-sm text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
                  <svg v-if="t.status === 'uploading'" class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
                  </svg>
                  <svg v-else class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                </button>
                <button @click="uploads.cancel(t.id)" title="Cancel"
                  class="p-1 rounded-sm text-[var(--c-text-3)] hover:text-danger hover:bg-danger/10 transition-colors">
                  <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="4" y="4" width="16" height="16" rx="2"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <!-- ── Job notifications ─────────────────────────────────────── -->
          <div
            v-for="n in notifications"
            :key="n.id"
            class="px-3.5 py-2.5"
          >
            <div class="flex items-center gap-2.5 min-w-0">
              <!-- Icon -->
              <div class="shrink-0 w-6 h-6 rounded-md flex items-center justify-center"
                :class="n.type === 'success' ? 'bg-success/10 text-success'
                      : n.type === 'error'   ? 'bg-danger/10 text-danger'
                      : n.type === 'info'    ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
                      :                        'bg-[var(--c-surface-deep)] text-[var(--c-text-3)]'">
                <!-- Spinner for progress -->
                <svg v-if="n.type === 'progress'" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                <svg v-else-if="n.type === 'success'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                </svg>
                <svg v-else-if="n.type === 'error'" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
                <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
              </div>

              <!-- Title + detail -->
              <div class="flex-1 min-w-0">
                <span class="text-xs text-[var(--c-text-1)] leading-snug">{{ n.title }}</span>
                <p v-if="n.detail" class="text-[10px] text-[var(--c-text-3)] mt-0.5 truncate">{{ n.detail }}</p>
                <!-- Progress bar -->
                <div v-if="n.progress != null" class="mt-1.5 h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                  <div v-if="n.progress < 0" class="h-full w-1/3 bg-[var(--c-accent)] rounded-full animate-[slide_1.2s_ease-in-out_infinite]" />
                  <div v-else class="h-full rounded-full bg-[var(--c-accent)] transition-all" :style="{ width: n.progress + '%' }" />
                </div>
              </div>

              <!-- Dismiss -->
              <button v-if="n.type !== 'progress'" @click="dismiss(n.id)"
                class="shrink-0 p-1 rounded-sm text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Empty state -->
          <div v-if="!hasItems" class="flex flex-col items-center justify-center gap-1.5 text-[var(--c-text-3)] py-10 select-none">
            <svg class="w-6 h-6 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.25">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            <p class="text-xs">Nothing in progress</p>
          </div>

        </div>

        <!-- Footer: clear done -->
        <div v-if="hasDismissible" class="px-3.5 py-2 border-t border-[var(--c-border)] shrink-0">
          <button @click="dismissAll()" class="text-[10px] text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors uppercase tracking-wide">
            Clear all
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.nm-enter-active, .nm-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.nm-enter-from, .nm-leave-to { opacity: 0; transform: translateX(-4px); }

@keyframes slide {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
</style>
