<script setup lang="ts">
import { computed, watch } from 'vue'
import { useSystemNotifications, type SystemNotification } from '../lib/systemNotifications'

const props = defineProps<{ open: boolean; pos: { bottom: number; left: number } }>()
defineEmits<{ close: [] }>()

const { items, unread, refresh, markAllRead } = useSystemNotifications()

// Fresh data every time the bell opens.
watch(() => props.open, open => { if (open) void refresh() })

const hasItems = computed(() => items.value.length > 0)
const hasUnread = computed(() => unread.value > 0)

function itemTitle(n: SystemNotification): string {
  const action = n.eventType === 'alert.raised' ? 'Alert raised' : 'Alert cleared'
  return `${action} - ${n.target}`
}

function formatTime(createdAt: string): string {
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  const d = new Date(createdAt)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
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
          <button @click="$emit('close')" aria-label="Close activity panel" class="p-1 rounded-sm text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Persisted notification list -->
        <div class="flex-1 overflow-y-auto divide-y divide-[var(--c-border)]">

          <div
            v-for="n in items"
            :key="n.id"
            class="px-3.5 py-2.5"
          >
            <div class="flex items-start gap-2.5 min-w-0">
              <!-- Severity dot -->
              <span
                class="shrink-0 mt-1.5 h-1.5 w-1.5 rounded-full"
                :class="n.severity === 'critical' ? 'bg-danger'
                     : n.severity === 'warning'  ? 'bg-warning'
                     :                             'bg-[var(--c-text-3)]'"
              />

              <!-- Title + detail -->
              <div class="flex-1 min-w-0">
                <span class="block text-xs text-[var(--c-text-1)] leading-snug truncate">{{ itemTitle(n) }}</span>
                <p class="text-[10px] text-[var(--c-text-3)] mt-0.5 leading-snug truncate">{{ n.message }}</p>
              </div>

              <!-- Time -->
              <span class="shrink-0 text-[10px] text-[var(--c-text-3)] leading-snug whitespace-nowrap">{{ formatTime(n.createdAt) }}</span>
            </div>
          </div>

          <!-- Empty state -->
          <div v-if="!hasItems" class="flex flex-col items-center justify-center gap-1.5 text-[var(--c-text-3)] py-10 select-none">
            <svg class="w-6 h-6 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
            <p class="text-xs">No notifications</p>
          </div>

        </div>

        <!-- Footer: mark all read -->
        <div v-if="hasItems" class="px-3.5 py-2 border-t border-[var(--c-border)] shrink-0">
          <button
            @click="markAllRead()"
            :disabled="!hasUnread"
            class="text-[10px] text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors uppercase tracking-wide disabled:opacity-50 disabled:hover:text-[var(--c-text-3)] disabled:cursor-default"
          >
            Mark all read
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.nm-enter-active, .nm-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.nm-enter-from, .nm-leave-to { opacity: 0; transform: translateX(-4px); }
</style>
