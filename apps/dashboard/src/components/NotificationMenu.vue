<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { BellIcon, CheckIcon, InfoIcon, XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useSystemNotifications, type SystemNotification } from '../lib/systemNotifications'
import { useNotifications } from '../lib/notifications'
import { openJobLogs } from '../lib/jobLogs'
import SegmentedBar from './ui/SegmentedBar.vue'
import LoadingSpinner from './ui/LoadingSpinner.vue'

/* Body of the Activity popover (DashboardLayout): mounted each time it opens. */
const emit = defineEmits<{ close: [] }>()

function viewLogs(jobId: string) {
  emit('close')
  openJobLogs(jobId)
}

const { items, unread, refresh, markAllRead } = useSystemNotifications()
// In-memory operations started from this browser (track/trackBatch): shown
// above the persisted system notifications so progress and errors stay visible.
const { notifications: operations, dismiss } = useNotifications()

// Fresh data every time the bell opens.
onMounted(() => { void refresh() })

const hasOperations = computed(() => operations.value.length > 0)
const hasItems = computed(() => items.value.length > 0)
const hasUnread = computed(() => unread.value > 0)

function itemTitle(n: SystemNotification): string {
  const action = n.eventType === 'alert.raised' ? 'Alert raised'
    : n.eventType === 'job.failed' ? 'Failed'
    : n.eventType === 'update.failed' ? 'Update failed'
    : 'Alert cleared'
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
  <div class="flex max-h-[420px] flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-3.5 py-2 border-b shrink-0">
          <span class="text-xs font-semibold text-foreground/80 uppercase tracking-caps">Activity</span>
          <Button variant="ghost" size="icon-xs" class="text-muted-foreground" aria-label="Close activity panel" @click="emit('close')">
            <XIcon />
          </Button>
        </div>

        <!-- Persisted notification list -->
        <div class="flex-1 overflow-y-auto divide-y divide-border">

          <!-- Operations in progress / recently finished -->
          <div
            v-for="op in operations"
            :key="`op-${op.id}`"
            class="px-3.5 py-2.5"
          >
            <div class="flex items-start gap-2.5 min-w-0">
              <div class="shrink-0 w-5 h-5 rounded-md flex items-center justify-center"
                :class="op.type === 'success' ? 'bg-success/10 text-success'
                      : op.type === 'error'   ? 'bg-destructive/10 text-destructive'
                      :                         'bg-muted text-muted-foreground'">
                <LoadingSpinner v-if="op.type === 'progress'" class="text-current" />
                <CheckIcon v-else-if="op.type === 'success'" class="size-3" />
                <XIcon v-else-if="op.type === 'error'" class="size-3" />
                <InfoIcon v-else class="size-3" />
              </div>

              <div class="flex-1 min-w-0">
                <span class="block text-xs text-foreground leading-snug truncate">{{ op.title }}</span>
                <p v-if="op.detail" class="text-2xs mt-0.5 leading-snug break-words"
                  :class="op.type === 'error' ? 'text-destructive' : 'text-muted-foreground'">{{ op.detail }}</p>
                <Button v-if="op.jobId" variant="link" class="mt-0.5 h-auto p-0 text-2xs" @click="viewLogs(op.jobId)">View logs</Button>
                <SegmentedBar
                  v-if="op.type === 'progress'"
                  class="mt-1.5"
                  :percent="op.progress ?? 0"
                  :indeterminate="op.progress === -1 || op.progress == null"
                  height="compact"
                  color="var(--primary)"
                />
              </div>

              <Button v-if="op.type !== 'progress'" variant="ghost" size="icon-xs" class="shrink-0 text-muted-foreground" aria-label="Dismiss operation" @click="dismiss(op.id)">
                <XIcon />
              </Button>
            </div>
          </div>

          <div
            v-for="n in items"
            :key="n.id"
            class="px-3.5 py-2.5"
          >
            <div class="flex items-start gap-2.5 min-w-0">
              <!-- Severity dot -->
              <span
                class="shrink-0 mt-1.5 h-1.5 w-1.5 rounded-full"
                :class="n.severity === 'critical' ? 'bg-destructive'
                     : n.severity === 'warning'  ? 'bg-warning'
                     :                             'bg-muted-foreground'"
              />

              <!-- Title + detail -->
              <div class="flex-1 min-w-0">
                <span class="block text-xs text-foreground leading-snug truncate">{{ itemTitle(n) }}</span>
                <p class="text-2xs text-muted-foreground mt-0.5 leading-snug truncate">{{ n.message }}</p>
              </div>

              <!-- Time -->
              <span class="shrink-0 text-2xs text-muted-foreground leading-snug whitespace-nowrap">{{ formatTime(n.createdAt) }}</span>
            </div>
          </div>

          <!-- Empty state -->
          <div v-if="!hasItems && !hasOperations" class="flex flex-col items-center justify-center gap-1.5 text-muted-foreground py-10 select-none">
            <BellIcon class="size-6 opacity-25" />
            <p class="text-xs">No notifications</p>
          </div>

        </div>

        <!-- Footer: mark all read -->
        <div v-if="hasItems" class="px-3.5 py-1.5 border-t shrink-0">
          <Button variant="ghost" size="xs" class="-ml-2 text-muted-foreground" :disabled="!hasUnread" @click="markAllRead()">
            Mark all read
          </Button>
        </div>
  </div>
</template>
