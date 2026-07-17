<script setup lang="ts">
import { computed } from 'vue'
import { useNotifications } from '../lib/notifications'

defineProps<{ open: boolean; pos: { bottom: number; left: number } }>()
defineEmits<{ close: [] }>()

const { notifications, dismiss, dismissAll } = useNotifications()

const hasItems = computed(() => notifications.value.length > 0)
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
