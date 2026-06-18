<script setup lang="ts">
import { useNotifications } from '../lib/notifications'
import SegmentedBar from './ui/SegmentedBar.vue'
const { notifications, dismiss } = useNotifications()

const tags: Record<string, string> = { progress: '...', success: 'OK', error: 'ERR', info: 'I' }
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed z-50 flex flex-col pointer-events-none overflow-y-auto
             inset-x-3 bottom-[4.75rem] max-h-[40vh]
             sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-96 sm:max-h-[60vh]"
    >
      <TransitionGroup name="notif" tag="div" class="flex flex-col">
        <div
          v-for="n in notifications"
          :key="n.id"
          class="pointer-events-auto bg-[var(--c-bg)] border-t border-[var(--c-border)] px-3 py-2 font-mono text-xs"
        >
          <div class="flex items-start gap-2">
            <span
              class="shrink-0 font-bold tracking-wider"
              :class="{
                'text-[var(--c-text-3)]': n.type === 'progress' || n.type === 'info',
                'text-[var(--c-success)]': n.type === 'success',
                'text-[var(--c-accent)]': n.type === 'error',
              }"
            >[{{ tags[n.type] }}]</span>

            <div class="flex-1 min-w-0">
              <div class="text-[var(--c-text-1)] leading-snug truncate">{{ n.title }}</div>
              <div v-if="n.detail" class="text-[var(--c-text-3)] mt-0.5 leading-snug">{{ n.detail }}</div>
              <SegmentedBar
                v-if="n.type === 'progress'"
                class="mt-1.5"
                :percent="n.progress ?? 0"
                :indeterminate="n.progress === -1 || n.progress == null"
                height="compact"
                color="var(--c-accent)"
              />
            </div>

            <button
              v-if="n.type !== 'progress'"
              @click="dismiss(n.id)"
              class="shrink-0 text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors"
            >[x]</button>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.notif-enter-active, .notif-leave-active { transition: opacity 0.15s ease; }
.notif-enter-from, .notif-leave-to { opacity: 0; }
</style>
