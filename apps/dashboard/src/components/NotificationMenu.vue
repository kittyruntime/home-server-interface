<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted } from 'vue'
import { BellIcon, CircleAlertIcon, CircleCheckIcon, InfoIcon, SettingsIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import type { Component } from 'vue'
import { Button } from '@/components/ui/button'
import { useSystemNotifications, type SystemNotification } from '../lib/systemNotifications'
import { useNotifications } from '../lib/notifications'
import { openJobLogs } from '../lib/jobLogs'
import { focusFolder, focusSettings } from '../lib/app-focus'
import { taskKindOf } from '../lib/activity-label'
import { useAuth } from '../lib/auth'
import SegmentedBar from './ui/SegmentedBar.vue'
import LoadingSpinner from './ui/LoadingSpinner.vue'
import ActivityTaskList from './activity/ActivityTaskList.vue'
import { useActivity } from '../lib/activity'

// Body of the Activity popover (DashboardLayout), mounted each time it opens:
// what runs in the background first (on the NAS and in this browser), then the
// notifications: new ones, then earlier ones (read), so marking as read
// visibly moves them out of the way.
const props = defineProps<{ page?: boolean }>()
const emit = defineEmits<{ close: []; openPage: [] }>()
const { t } = useI18n()
const { isAdmin } = useAuth()

const { items, unread, refresh, markAllRead, markRead, clear } = useSystemNotifications()
// In-memory operations started from this browser (track/trackBatch).
const { notifications: operations, dismiss } = useNotifications()

onMounted(() => { void refresh() })

const fresh = computed(() => items.value.filter(n => !n.readAt))
const earlier = computed(() => items.value.filter(n => n.readAt).slice(0, 20))
const { items: tasks } = useActivity()
const runningOps = computed(() => operations.value.filter(o => o.type === 'progress'))
const finishedOps = computed(() => operations.value.filter(o => o.type !== 'progress'))
// The Activity page shows running tasks in their own tab.
const hasRunning = computed(() => !props.page && (tasks.value.length > 0 || runningOps.value.length > 0))
const hasNotifications = computed(() => finishedOps.value.length > 0 || items.value.length > 0)
const isEmpty = computed(() => !hasRunning.value && !hasNotifications.value)
// An administrator empties the panel; another account marks it read.
const canClear = computed(() => (isAdmin.value ? items.value.length > 0 : unread.value > 0) || finishedOps.value.length > 0)

type Look = { icon: Component; tint: string; kind: string }
function look(n: SystemNotification): Look {
  if (n.eventType === 'alert.cleared') return { icon: CircleCheckIcon, tint: 'text-success', kind: 'alertCleared' }
  if (n.eventType === 'task.completed') return { icon: CircleCheckIcon, tint: 'text-success', kind: 'task' }
  if (n.eventType === 'task.failed') return { icon: TriangleAlertIcon, tint: 'text-warning', kind: 'task' }
  const kind = n.eventType === 'alert.raised' ? 'alertRaised'
    : n.eventType === 'job.failed' ? 'jobFailed'
    : n.eventType === 'update.failed' ? 'updateFailed'
    : 'other'
  if (n.severity === 'critical') return { icon: CircleAlertIcon, tint: 'text-error', kind }
  if (n.severity === 'warning') return { icon: TriangleAlertIcon, tint: 'text-warning', kind }
  return { icon: InfoIcon, tint: 'text-info', kind }
}

function formatTime(createdAt: string): string {
  const at = new Date(createdAt).getTime()
  if (Number.isNaN(at)) return ''
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return t('uis.settings.NotificationMenu.justNow')
  if (s < 3600) return t('uis.settings.NotificationMenu.mAgo', { p0: Math.floor(s / 60) })
  if (s < 86400) return t('uis.settings.NotificationMenu.hAgo', { p0: Math.floor(s / 3600) })
  return new Date(createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Also clears this browser's finished operations, so the badge goes back to zero.
async function clearAll() {
  for (const op of finishedOps.value) dismiss(op.id)
  if (isAdmin.value) { if (items.value.length > 0) await clear() }
  else if (unread.value > 0) await markAllRead()
}

// "Copie terminée", "Échec du déplacement": a whole phrase per task, so the
// French agrees with each noun.
function title(n: SystemNotification): string {
  const l = look(n)
  if (l.kind !== 'task') return t(`activity.kind.${l.kind}`)
  return t(`activity.${n.eventType === 'task.failed' ? 'taskFailed' : 'taskDone'}.${taskKindOf(n.source)}`)
}

// Reading a task result opens its folder.
function openNotification(n: SystemNotification) {
  void markRead(n.id)
  if (!n.link) return
  emit('close')
  focusFolder(n.link)
}

function viewLogs(jobId: string) {
  emit('close')
  openJobLogs(jobId)
}

function openSettings() {
  emit('close')
  focusSettings('notifications')
}
</script>

<template>
  <div class="flex flex-col" :class="page ? '' : 'max-h-[min(32rem,80vh)]'">
    <!-- Header -->
    <div v-if="!page" class="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 py-2.5">
      <h2 class="text-sm font-semibold">{{ t('activity.title') }}</h2>
      <span v-if="unread > 0" class="badge badge-primary badge-sm tabular-nums">{{ t('activity.unreadCount', { count: unread }) }}</span>
      <div class="flex-1" />
      <Button v-if="isAdmin" variant="ghost" size="icon-xs" class="text-base-content/70" :tooltip="t('activity.settings')" :aria-label="t('activity.settings')" @click="openSettings">
        <SettingsIcon />
      </Button>
      <Button variant="ghost" size="icon-xs" class="text-base-content/70" :aria-label="t('activity.close')" @click="emit('close')">
        <XIcon />
      </Button>
    </div>

    <div class="flex-1 overflow-y-auto">
      <!-- Background tasks: on the NAS and in this browser -->
      <section v-if="hasRunning" :aria-label="t('activity.running')">
        <h3 class="px-4 pt-3 pb-1 text-2xs font-semibold uppercase tracking-caps text-base-content/70">
          {{ t('activity.running') }} <span class="badge badge-ghost badge-xs tabular-nums">{{ tasks.length + runningOps.length }}</span>
        </h3>
        <ActivityTaskList :items="tasks" />
        <ul v-if="runningOps.length" class="divide-y divide-base-300 border-t border-base-300">
          <li v-for="op in runningOps" :key="`op-${op.id}`" class="flex items-start gap-3 px-4 py-2.5">
            <span class="mt-0.5 shrink-0 text-base-content/70"><LoadingSpinner class="text-current" /></span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm">{{ op.title }}</p>
              <SegmentedBar class="mt-1.5" :percent="op.progress ?? 0"
                :indeterminate="op.progress === -1 || op.progress == null" height="compact" color="var(--color-primary)" />
            </div>
          </li>
        </ul>
      </section>

      <!-- Notifications: this browser's finished operations, then new and earlier ones -->
      <section v-if="hasNotifications" :aria-label="t('activity.notifications')">
        <h3 v-if="!page" class="px-4 pt-3 pb-1 text-2xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('activity.notifications') }}</h3>
        <ul v-if="finishedOps.length" class="divide-y divide-base-300">
          <li v-for="op in finishedOps" :key="`op-${op.id}`" class="flex items-start gap-3 px-4 py-2.5">
            <span class="mt-0.5 shrink-0" :class="op.type === 'success' ? 'text-success' : op.type === 'error' ? 'text-error' : 'text-base-content/70'">
              <CircleCheckIcon v-if="op.type === 'success'" class="size-4" aria-hidden="true" />
              <CircleAlertIcon v-else-if="op.type === 'error'" class="size-4" aria-hidden="true" />
              <InfoIcon v-else class="size-4" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm">{{ op.title }}</p>
              <p v-if="op.detail" class="mt-0.5 break-words text-xs" :class="op.type === 'error' ? 'text-error' : 'text-base-content/70'">{{ op.detail }}</p>
              <Button v-if="op.jobId" variant="link" class="mt-0.5 h-auto p-0 text-xs" @click="viewLogs(op.jobId)">{{ t('activity.viewLogs') }}</Button>
            </div>
            <Button variant="ghost" size="icon-xs" class="shrink-0 text-base-content/70" :aria-label="t('activity.dismiss')" @click="dismiss(op.id)">
              <XIcon />
            </Button>
          </li>
        </ul>
        <template v-for="group in [{ key: 'new', list: fresh }, { key: 'earlier', list: earlier }]" :key="group.key">
          <p v-if="group.key === 'earlier' && group.list.length && (fresh.length || finishedOps.length)" class="px-4 pt-2 pb-1 text-2xs text-base-content/70">{{ t('activity.earlier') }}</p>
          <ul v-show="group.list.length" class="divide-y divide-base-300" :aria-label="t(`activity.${group.key}`)">
            <li v-for="n in group.list" :key="n.id">
              <button type="button" class="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-base-200 focus-visible:bg-base-200 focus-visible:outline-none"
                :class="n.readAt ? 'opacity-70' : ''" :aria-label="n.link ? t('activity.openFolder') : n.readAt ? undefined : t('activity.markRead')" @click="openNotification(n)">
                <component :is="look(n).icon" class="mt-0.5 size-4 shrink-0" :class="look(n).tint" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-baseline gap-2">
                    <span class="min-w-0 flex-1 truncate text-sm" :class="n.readAt ? '' : 'font-medium'">
                      {{ title(n) }}<template v-if="n.target"> · {{ n.target }}</template>
                    </span>
                    <span class="shrink-0 text-xs tabular-nums text-base-content/70">{{ formatTime(n.createdAt) }}</span>
                  </span>
                  <span class="mt-0.5 line-clamp-2 block text-xs text-base-content/70">{{ n.message }}</span>
                </span>
                <span v-if="!n.readAt" class="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </template>
      </section>

      <!-- Empty state -->
      <div v-if="isEmpty" class="flex flex-col items-center gap-1.5 px-6 py-10 text-center text-base-content/70 select-none">
        <BellIcon class="size-6 opacity-30" aria-hidden="true" />
        <p class="text-sm">{{ t('activity.empty') }}</p>
        <p class="text-xs">{{ t('activity.emptyHint') }}</p>
      </div>
    </div>

    <!-- Footer -->
    <div class="flex shrink-0 items-center border-t border-base-300 px-2 py-1.5">
      <Button v-if="hasNotifications" variant="ghost" size="xs" class="text-base-content/70" :disabled="!canClear" @click="clearAll()">
        {{ isAdmin ? t('activity.clearAll') : t('activity.markAllRead') }}
      </Button>
      <div class="flex-1" />
      <Button v-if="!page" variant="ghost" size="xs" class="text-primary" @click="emit('openPage')">
        {{ t('activity.seeAll') }}
      </Button>
    </div>
  </div>
</template>
