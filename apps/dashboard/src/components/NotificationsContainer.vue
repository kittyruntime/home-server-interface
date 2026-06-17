<script setup lang="ts">
import { useNotifications } from '../lib/notifications'
const { notifications, dismiss } = useNotifications()
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed z-50 flex flex-col gap-2 pointer-events-none overflow-y-auto
             inset-x-3 bottom-[4.75rem] max-h-[40vh]
             sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-80 sm:max-h-[60vh]"
    >
      <TransitionGroup name="notif" tag="div" class="flex flex-col gap-2">
        <div
          v-for="n in notifications"
          :key="n.id"
          class="pointer-events-auto flex flex-col gap-1.5 px-4 py-3 rounded-xl shadow-2xl
                 bg-[var(--c-surface)] border text-sm"
          :class="{
            'border-[var(--c-border-strong)]':  n.type === 'progress' || n.type === 'info',
            'border-emerald-600/40': n.type === 'success',
            'border-red-600/40':     n.type === 'error',
          }"
        >
          <!-- Header row -->
          <div class="flex items-start gap-2.5">
            <!-- Icon -->
            <div class="mt-0.5 shrink-0">
              <!-- Spinner -->
              <svg v-if="n.type === 'progress'" class="w-4 h-4 text-[var(--c-accent)] animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
              <!-- Success -->
              <svg v-else-if="n.type === 'success'" class="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
              </svg>
              <!-- Error -->
              <svg v-else-if="n.type === 'error'" class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
              <!-- Info -->
              <svg v-else class="w-4 h-4 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z"/>
              </svg>
            </div>

            <!-- Text -->
            <div class="flex-1 min-w-0">
              <div :class="['font-medium leading-snug', n.type === 'error' ? 'text-red-300' : n.type === 'success' ? 'text-emerald-300' : 'text-[var(--c-text-1)]']">
                {{ n.title }}
              </div>
              <div v-if="n.detail" class="text-xs text-[var(--c-text-3)] mt-0.5 leading-snug">{{ n.detail }}</div>
            </div>

            <!-- Dismiss -->
            <button
              v-if="n.type !== 'progress'"
              @click="dismiss(n.id)"
              class="text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors shrink-0 mt-0.5"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

          <!-- Progress bar -->
          <div v-if="n.type === 'progress'" class="h-0.5 rounded-full bg-[var(--c-surface-deep)] overflow-hidden">
            <div
              v-if="n.progress === -1 || n.progress == null"
              class="h-full w-1/3 rounded-full bg-[var(--c-accent)] animate-[slide_1.2s_ease-in-out_infinite]"
            />
            <div
              v-else
              class="h-full rounded-full bg-[var(--c-accent)] transition-all duration-300"
              :style="{ width: n.progress + '%' }"
            />
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.notif-enter-active, .notif-leave-active { transition: all 0.2s ease; }
.notif-enter-from  { opacity: 0; transform: translateX(12px); }
.notif-leave-to    { opacity: 0; transform: translateX(12px); }

@keyframes slide {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
</style>
