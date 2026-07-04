<script setup lang="ts">
import { useToast } from '../../lib/toast'

const { toasts, dismiss } = useToast()
</script>

<template>
  <Teleport to="body">
    <div class="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none" style="max-width: 360px">
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border pointer-events-auto"
          :class="t.type === 'error'   ? 'bg-[var(--c-surface-alt)] border-[var(--c-danger)]/40 text-[var(--c-text-1)]'
                : t.type === 'success' ? 'bg-[var(--c-surface-alt)] border-success/30 text-[var(--c-text-1)]'
                :                        'bg-[var(--c-surface-alt)] border-[var(--c-border-strong)] text-[var(--c-text-1)]'"
        >
          <!-- Icon -->
          <div class="shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center"
            :class="t.type === 'error'   ? 'bg-[var(--c-danger)]/15 text-[var(--c-danger)]'
                  : t.type === 'success' ? 'bg-success/15 text-success'
                  :                        'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'">
            <svg v-if="t.type === 'error'" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
            <svg v-else-if="t.type === 'success'" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            <svg v-else class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
          </div>

          <!-- Message -->
          <span class="flex-1 text-sm leading-snug">{{ t.message }}</span>

          <!-- Dismiss -->
          <button @click="dismiss(t.id)" class="shrink-0 p-0.5 -mr-1 text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors rounded">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-enter-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.toast-leave-active { transition: opacity 0.25s ease, transform 0.25s ease; }
.toast-enter-from   { opacity: 0; transform: translateY(-8px) scale(0.97); }
.toast-leave-to     { opacity: 0; transform: translateY(-4px) scale(0.97); }
.toast-move         { transition: transform 0.2s ease; }
</style>
