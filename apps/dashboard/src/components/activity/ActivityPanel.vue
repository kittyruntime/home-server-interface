<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { BellIcon, CircleAlertIcon, CircleCheckIcon, CircleSlashIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ActivityTaskList from './ActivityTaskList.vue'
import NotificationMenu from '../NotificationMenu.vue'
import LoadingState from '../ui/LoadingState.vue'
import { formatElapsed, useActivity, type ActivityItem } from '../../lib/activity'
import { activityLabel } from '../../lib/activity-label'
import { useSystemNotifications } from '../../lib/systemNotifications'
import { openJobLogs } from '../../lib/jobLogs'
import { useAuth } from '../../lib/auth'
import { trpc } from '../../lib/trpc'

/* The Activity app: the bell panel with room to breathe, plus the history of
   finished background tasks. */
type Tab = 'running' | 'notifications' | 'history'
type HistoryItem = Awaited<ReturnType<typeof trpc.tasks.history.query>>['items'][number]

const { t } = useI18n()
const { isAdmin } = useAuth()
const activity = useActivity()
const { unread } = useSystemNotifications()
const tab = ref<Tab>('running')

onMounted(() => activity.setOpen(true))
onBeforeUnmount(() => activity.setOpen(false))

const history = ref<HistoryItem[]>([])
const nextCursor = ref<string | null>(null)
const historyLoading = ref(false)
const historyLoaded = ref(false)

async function loadHistory(more = false) {
  historyLoading.value = true
  try {
    const page = await trpc.tasks.history.query(more && nextCursor.value ? { cursor: nextCursor.value } : {})
    history.value = more ? [...history.value, ...page.items] : page.items
    nextCursor.value = page.nextCursor
    historyLoaded.value = true
  } catch { /* transient: the tab shows what it has */ } finally {
    historyLoading.value = false
  }
}

function select(value: unknown) {
  tab.value = value as Tab
  void activity.refresh()
  if (tab.value === 'history') void loadHistory()
}

function historyLabel(h: HistoryItem): string {
  return activityLabel({ ...h, status: 'running', percent: null, remainingSec: null, cancellable: false, pausable: false, interrupted: false } as ActivityItem, t)
}

function duration(h: HistoryItem): string {
  if (!h.startedAt || !h.finishedAt) return ''
  return formatElapsed(new Date(h.finishedAt).getTime() - new Date(h.startedAt).getTime())
}

function when(h: HistoryItem): string {
  const at = h.finishedAt ?? h.createdAt
  return new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const runningCount = computed(() => activity.items.value.length)
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div class="shrink-0 px-4 pt-4 sm:px-6">
      <Tabs :model-value="tab" class="mx-auto max-w-3xl" @update:model-value="select">
        <TabsList class="max-w-full overflow-x-auto">
          <TabsTrigger value="running">
            <span class="inline-flex items-center gap-1.5 whitespace-nowrap">{{ t('activity.running') }}<span v-if="runningCount" class="badge badge-ghost badge-xs tabular-nums">{{ runningCount }}</span></span>
          </TabsTrigger>
          <TabsTrigger value="notifications">
            <span class="inline-flex items-center gap-1.5 whitespace-nowrap">{{ t('activity.notifications') }}<span v-if="unread" class="badge badge-primary badge-xs tabular-nums">{{ unread > 99 ? '99+' : unread }}</span></span>
          </TabsTrigger>
          <TabsTrigger value="history"><span class="whitespace-nowrap">{{ t('activity.history') }}</span></TabsTrigger>
        </TabsList>
      </Tabs>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      <div class="mx-auto max-w-3xl">
        <!-- Running -->
        <template v-if="tab === 'running'">
          <div v-if="activity.items.value.length" class="overflow-hidden rounded-box border border-base-300 bg-base-100">
            <ActivityTaskList :items="activity.items.value" />
          </div>
          <div v-else class="flex flex-col items-center gap-1.5 py-12 text-center text-base-content/70">
            <BellIcon class="size-6 opacity-30" aria-hidden="true" />
            <p class="text-sm">{{ t('activity.nothingRunning') }}</p>
            <p class="text-xs">{{ t('activity.nothingRunningHint') }}</p>
          </div>
        </template>

        <!-- Notifications -->
        <div v-else-if="tab === 'notifications'" class="overflow-hidden rounded-box border border-base-300 bg-base-100">
          <NotificationMenu page />
        </div>

        <!-- History -->
        <template v-else>
          <LoadingState v-if="historyLoading && !historyLoaded" variant="block" />
          <p v-else-if="!history.length" class="py-12 text-center text-sm text-base-content/70">{{ t('activity.historyEmpty') }}</p>
          <template v-else>
            <ul class="divide-y divide-base-300 overflow-hidden rounded-box border border-base-300 bg-base-100">
              <li v-for="h in history" :key="h.id" class="flex items-start gap-3 px-4 py-2.5">
                <CircleCheckIcon v-if="h.status === 'completed'" class="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                <CircleSlashIcon v-else-if="h.status === 'cancelled'" class="mt-0.5 size-4 shrink-0 text-base-content/70" aria-hidden="true" />
                <CircleAlertIcon v-else class="mt-0.5 size-4 shrink-0 text-error" aria-hidden="true" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm">{{ historyLabel(h) }}</p>
                  <p class="mt-0.5 text-xs text-base-content/70">
                    {{ t(`activity.result.${h.status}`) }} · <span class="tabular-nums">{{ when(h) }}</span>
                    <template v-if="duration(h)"> · {{ t('activity.took', { time: duration(h) }) }}</template>
                    <template v-if="typeof h.owner === 'object'"> · {{ h.owner.username ? t('activity.owner.user', { name: h.owner.username }) : t('activity.owner.deleted') }}</template>
                  </p>
                  <p v-if="h.error && h.status === 'failed'" class="mt-0.5 break-words text-xs text-error">{{ h.error }}</p>
                  <Button v-if="isAdmin && h.status === 'failed'" variant="link" class="mt-0.5 h-auto p-0 text-xs" @click="openJobLogs(h.id)">{{ t('activity.viewLogs') }}</Button>
                </div>
              </li>
            </ul>
            <div v-if="nextCursor" class="mt-3 flex justify-center">
              <Button variant="outline" size="sm" :disabled="historyLoading" @click="loadHistory(true)">{{ t('activity.loadMore') }}</Button>
            </div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>
