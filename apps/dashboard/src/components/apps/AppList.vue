<script setup lang="ts">
import { useNarrow } from '@/lib/viewport'
import { useI18n } from 'vue-i18n'
import Tip from '../ui/Tip.vue'
import { BookmarkIcon, EllipsisIcon, SquareIcon, ExternalLinkIcon, PackageIcon, PlayIcon, PlusIcon, RefreshCwIcon, ScrollTextIcon, SquarePenIcon, Trash2Icon, SearchIcon, TriangleAlertIcon } from '@lucide/vue'
import { ButtonGroup } from '@/components/ui/button-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useVolumeHolds, holdLabel } from '../../lib/volumes'
import AppFormModal from './AppFormModal.vue'
import ContainerLogsPanel from './ContainerLogsPanel.vue'
import UnmanagedContainers from './UnmanagedContainers.vue'
import Modal from '../ui/Modal.vue'
import EmptyState from '../ui/EmptyState.vue'
import { pollJobResult, JobError, type JobObservation, type JobResult } from '../../lib/jobs'
import { viewableJobId, viewLogsAction } from '../../lib/jobLogs'
import { useNotifications } from '../../lib/notifications'
import { useToast } from '../../lib/toast'
import { applyPlannedJob } from '../../lib/plan'
import { pendingAppFocus, appToFocus } from '../../lib/app-focus'
import { updateText } from '../../lib/app-update'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { safePinnedUrl } from '../../lib/pinned-url'
import { filterApps, summarizeApps } from '../../lib/app-list'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { clearAppJob, knownAppJobs, registerAppJob, type PendingAppJob } from '../../lib/app-jobs'

const narrow = useNarrow()

const { t } = useI18n()

const { push: pushNotif, update: updateNotif, dismiss: dismissNotif } = useNotifications()
const toast = useToast()

type App = Awaited<ReturnType<typeof trpc.container.app.list.query>>[number]

const apps          = ref<App[]>([])
const loading       = ref(true)
const loadError     = ref<string | null>(null)
const search        = ref('')
const showModal     = ref(false)
const editName      = ref<string | null>(null)
const actionLoading = ref<Record<string, string>>({})
let   refreshTimer: ReturnType<typeof setInterval> | null = null

const pinDialog     = ref<App | null>(null)
const pinDialogUrl  = ref('')
const pinDialogErr  = ref('')
const pinDialogBusy = ref(false)

const pinnedApps = computed(() => apps.value.filter(a => safePinnedUrl(a.app?.pinnedUrl)))
const visibleApps = computed(() => filterApps(apps.value, search.value))
const counts = computed(() => summarizeApps(apps.value))
const appHasPendingJob = (name: string) => knownAppJobs.has(name)
const pendingJobAction = (name: string) => knownAppJobs.get(name)?.action
const notificationByJob = new Map<string, string>()
const settledJobs = new Set<string>()
const checkingJobs = new Set<string>()

async function load() {
  loading.value = true
  loadError.value = null
  try { apps.value = await trpc.container.app.list.query() }
  catch (e: any) {
    loadError.value = e?.message ?? t('ui.apps.AppList.containersUnavailable')
    console.error('Failed to load apps:', e?.message)
  }
  finally { loading.value = false }
}

// Background refresh: no loading toggle: the spinner must show on the initial
// mount only, or the whole panel would flicker (and remount UnmanagedContainers)
// every 10 s.
async function silentRefresh() {
  await refreshKnownJobs()
  try {
    apps.value = await trpc.container.app.list.query()
    loadError.value = null
  } catch (e: any) {
    loadError.value = e?.message ?? t('ui.apps.AppList.containersUnavailable')
  }
}

const { holdForApp, refreshHolds } = useVolumeHolds()

onMounted(async () => {
  void refreshHolds()
  await load()
  refreshTimer = setInterval(silentRefresh, 10_000)
})

onUnmounted(() => {
  if (refreshTimer !== null) clearInterval(refreshTimer)
  if (focusTimer !== null) clearTimeout(focusTimer)
})

function statusDot(status: string) {
  switch (status) {
    case 'running':       return 'bg-success'
    case 'stopped':       return 'bg-base-content/70'
    case 'error':         return 'bg-error'
    case 'transitioning': return 'bg-warning animate-pulse'
    default:              return 'bg-warning'
  }
}

function statusText(status: string) {
  switch (status) {
    case 'running':       return { label: t('uis.apps.AppList.running'),  cls: 'border-success/40 bg-success/10 text-success' }
    case 'stopped':       return { label: t('uis.apps.AppList.stopped'),  cls: 'border-base-300 bg-base-200 text-base-content/70' }
    case 'error':         return { label: t('uis.apps.AppList.error'),    cls: 'border-error/40 bg-error/10 text-error' }
    case 'transitioning': return { label: t('uis.apps.AppList.updating'),cls: 'border-warning/40 bg-warning/10 text-warning' }
    default:              return { label: t('uis.apps.AppList.unknown'),  cls: 'border-base-300 bg-base-200 text-base-content/70' }
  }
}

function actionText(action: string) {
  return t(`ui.apps.AppList.action${action.charAt(0).toUpperCase()}${action.slice(1)}`)
}

function portsSummary(app: App): string {
  const ports = app.app?.ports ?? []
  if (!ports.length) return '-'
  return ports.slice(0, 2).map(p => `${p.hostPort}:${p.containerPort}`).join(', ')
    + (ports.length > 2 ? ` +${ports.length - 2}` : '')
}

function observeAction(notifId: string | null, job: JobObservation) {
  if (!notifId || job.status === 'completed' || job.status === 'failed') return
  updateNotif(notifId, {
    type: 'progress',
    detail: t(job.status === 'running' ? 'ui.apps.AppList.workerRunning' : 'ui.apps.AppList.workerQueued'),
  })
}

function jobPendingMessage(result: JobResult) {
  if (result.failureSource === 'observer') {
    return t('ui.apps.AppList.jobStatusUncertain', { p0: result.error ?? '' })
  }
  return result.error ?? t('ui.apps.AppList.jobStillRunning')
}

function keepJobPending(notifId: string, title: string, jobId: string, message: string) {
  updateNotif(notifId, { type: 'progress', title, detail: message, progress: -1, jobId })
  toast.info(message)
}

function notificationForJob(job: PendingAppJob): string {
  const existing = notificationByJob.get(job.jobId)
  if (existing) return existing
  const id = pushNotif({
    type: 'progress',
    title: `${job.action} ${job.name}…`,
    progress: -1,
    jobId: job.jobId,
  })
  notificationByJob.set(job.jobId, id)
  return id
}

function settleAppJob(job: PendingAppJob, status: 'completed' | 'failed', error?: string | null) {
  if (settledJobs.has(job.jobId)) return
  settledJobs.add(job.jobId)
  clearAppJob(job.name, job.jobId)
  const notifId = notificationForJob(job)
  if (status === 'completed') {
    updateNotif(notifId, { type: 'success', title: t('ui.apps.AppList.jobCompleted', { p0: job.name }), detail: undefined, progress: undefined })
    setTimeout(() => dismissNotif(notifId), 3000)
  } else {
    const failure = new JobError(error || t('ui.apps.AppList.jobFailed', { p0: job.name }), job.jobId)
    updateNotif(notifId, { type: 'error', title: t('ui.apps.AppList.jobFailed', { p0: job.name }), detail: failure.message, progress: undefined, jobId: job.jobId })
    toast.error(failure.message, viewLogsAction(failure))
  }
}

async function refreshKnownJobs() {
  const jobs = [...knownAppJobs.values()].filter(job => !checkingJobs.has(job.jobId))
  await Promise.all(jobs.map(async job => {
    checkingJobs.add(job.jobId)
    try {
      const observed = await trpc.tasks.get.query({ jobId: job.jobId })
      if (observed.status === 'completed' || observed.status === 'failed') {
        settleAppJob(job, observed.status, observed.error)
      }
    } catch {
      // An unreadable task remains pending; the Check status action can retry.
    } finally {
      checkingJobs.delete(job.jobId)
    }
  }))
}

async function observePendingJob(job: PendingAppJob) {
  const notifId = notificationForJob(job)
  const result = await pollJobResult(job.jobId, 10 * 60_000, observation => observeAction(notifId, observation))
  if (result.status === 'timeout' || result.failureSource === 'observer') {
    keepJobPending(notifId, `${job.action} ${job.name} is still running`, job.jobId, jobPendingMessage(result))
    await silentRefresh()
    return
  }
  settleAppJob(job, result.status, result.error)
  await silentRefresh()
}

async function checkPendingJob(app: App) {
  const job = knownAppJobs.get(app.name)
  if (!job || actionLoading.value[app.id]) return
  actionLoading.value[app.id] = 'check'
  try { await observePendingJob(job) }
  finally { delete actionLoading.value[app.id] }
}

async function runAction(id: string, action: 'start' | 'stop' | 'restart' | 'delete') {
  const app = apps.value.find(a => a.id === id)
  const name = app?.name ?? id
  if (knownAppJobs.has(name)) return
  actionLoading.value[id] = action
  const actionLabel = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', delete: 'Deleting' }[action]
  const planned = action === 'start' || action === 'delete'
  let notifId = !planned
    ? pushNotif({ type: 'progress', title: `${actionLabel} ${name}…`, progress: -1 })
    : null
  try {
    if (action === 'delete') {
      const jobId = await applyPlannedJob('app.remove', { name: app?.name ?? id, deleteData: false }, {
        title: t('uis.apps.AppList.delete', { p0: app?.name ?? id }), actionLabel: t('uis.apps.AppList.delete2'), danger: true,
        option: { key: 'deleteData', label: t('uis.apps.AppList.deleteData'), hint: t('uis.apps.AppList.deleteDataHint') },
      })
      const job = { name, jobId, action }
      registerAppJob(job)
      await observePendingJob(job)
      return
    }
    const jobId = action === 'start'
      ? await applyPlannedJob('app.start', { name: app?.name ?? id }, { title: t('uis.apps.AppList.start', { p0: app?.name ?? id }), actionLabel: t('uis.apps.AppList.start2') })
      : (await trpc.container.app[action].mutate({ name: app?.name ?? id })).jobId
    notifId ??= pushNotif({ type: 'progress', title: `${actionLabel} ${name}…`, progress: -1 })
    if (app) app.status = 'transitioning'
    const job = { name, jobId, action }
    registerAppJob(job)
    if (notifId) notificationByJob.set(jobId, notifId)
    await observePendingJob(job)
  } catch (e: any) {
    if (planned && e?.message === '') return // cancelled in the plan dialog
    await silentRefresh()
    if (notifId) updateNotif(notifId, { type: 'error', title: `${actionLabel} ${app?.name ?? ''} failed`, detail: e?.message, progress: undefined, jobId: viewableJobId(e) })
    toast.error(e.message ?? t('uis.apps.AppList.failed', { p0: action }), viewLogsAction(e))
  } finally {
    delete actionLoading.value[id]
  }
}

async function applyApp(id: string) {
  const app = apps.value.find(a => a.id === id)
  const name = app?.name ?? id
  if (knownAppJobs.has(name)) return
  actionLoading.value[id] = 'apply'
  try {
    const jobId = await applyPlannedJob('app.apply', { name: app?.name ?? id }, {
      title: t('uis.apps.AppList.apply', { p0: app?.name ?? id }), actionLabel: t('uis.apps.AppList.apply2'),
    })
    const job = { name, jobId, action: 'apply' }
    registerAppJob(job)
    await observePendingJob(job)
  } catch (e: any) {
    if (e?.message === '') return // cancelled in the plan dialog
    await silentRefresh()
    toast.error(e?.message ?? t('uis.apps.AppList.failedToApply'))
  } finally {
    delete actionLoading.value[id]
  }
}

const logsApp = ref<App | null>(null)

function openNew()        { editName.value = null; showModal.value = true }
// Multi-service stacks are fine too: the form modal handles them with a
// notice + the raw YAML editor (advanced tab only). Pinning from the UI is
// guarded server-side.
function openEdit(a: App) {
  editName.value = a.name
  showModal.value = true
}
function openLogs(a: App) { logsApp.value = a }

// A freshly installed app (#36): once listed, scroll to it, mark it for a
// few seconds and open its logs to follow its start-up.
const focusedName = ref<string | null>(null)
let focusTimer: ReturnType<typeof setTimeout> | null = null
watch([pendingAppFocus, apps], async () => {
  const app = appToFocus(pendingAppFocus.value, apps.value)
  if (!app) return
  pendingAppFocus.value = null
  focusedName.value = app.name
  logsApp.value = app
  if (focusTimer) clearTimeout(focusTimer)
  focusTimer = setTimeout(() => { focusedName.value = null }, 4000)
  await nextTick()
  for (const el of document.querySelectorAll<HTMLElement>(`[data-app-name="${CSS.escape(app.name)}"]`)) {
    if (el.offsetParent) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
})
// Already mounted: pick the new app up without waiting for the next refresh.
watch(pendingAppFocus, name => { if (name && !loading.value) void silentRefresh() })

defineExpose({ openNew })

function onSaved(_name?: string) { void load() }
function onDeployed(_name?: string) { void load() }

function openPinDialog(app: App) {
  pinDialog.value    = app
  pinDialogUrl.value = app.app?.pinnedUrl ?? ''
  pinDialogErr.value = ''
}

async function savePin() {
  const app = pinDialog.value
  if (!app) return
  const url = pinDialogUrl.value.trim()
  if (!url) { pinDialogErr.value = 'Enter a URL'; return }
  pinDialogBusy.value = true
  pinDialogErr.value  = ''
  try {
    await trpc.container.app.pin.mutate({ name: app.name, pinnedUrl: url })
    if (app.app) app.app.pinnedUrl = url
    pinDialog.value = null
  } catch (e: any) {
    pinDialogErr.value = e?.message ?? t('uis.apps.AppList.failedToSave')
  } finally {
    pinDialogBusy.value = false
  }
}

async function unpin(app: App) {
  try {
    await trpc.container.app.pin.mutate({ name: app.name, pinnedUrl: null })
    if (app.app) app.app.pinnedUrl = null
  } catch (e: any) {
    toast.error(e?.message ?? t('uis.apps.AppList.failedToUnpin'))
  }
}
</script>

<template>
  <div class="flex flex-col h-full w-full">

    <!-- Content -->
    <!-- Inline form (create / edit): replaces the list when active -->
  <AppFormModal
    v-if="showModal"
    :edit-name="editName"
    @close="showModal = false"
    @saved="onSaved"
    @deployed="onDeployed"
  />

  <div v-else class="flex-1 overflow-y-auto flex flex-col min-w-0">

      <!-- Loading -->
      <LoadingState v-if="loading && !apps.length" variant="block" />

      <!-- Empty state -->
      <div v-else-if="apps.length === 0 && !loadError" class="flex-1 flex items-center justify-center px-8">
        <div class="w-full max-w-3xl">
        <div class="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div class="rounded-lg border border-base-300 bg-base-100 px-4 py-3"><strong class="block text-xl tabular-nums text-success">0</strong><span class="text-xs text-base-content/70">{{ t('ui.apps.AppList.runningCount') }}</span></div>
          <div class="rounded-lg border border-base-300 bg-base-100 px-4 py-3"><strong class="block text-xl tabular-nums">0</strong><span class="text-xs text-base-content/70">{{ t('ui.apps.AppList.stoppedCount') }}</span></div>
          <div class="rounded-lg border border-base-300 bg-base-100 px-4 py-3"><strong class="block text-xl tabular-nums text-warning">0</strong><span class="text-xs text-base-content/70">{{ t('ui.apps.AppList.pendingCount') }}</span></div>
        </div>
        <EmptyState
          :message="t('ui.apps.AppList.noContainersYet')"
          :description="t('ui.apps.AppList.deployYourFirstContainerTo')"
        >
          <template #icon>
            <div class="w-16 h-16 rounded-xl bg-base-200 border border-base-300 flex items-center justify-center">
              <PackageIcon class="w-8 h-8 text-base-content/70" aria-hidden="true" />
            </div>
          </template>
          <template #action>
            <Button
              @click="openNew"
            >
              <PlusIcon class="w-4 h-4" aria-hidden="true" />
              {{ t('ui.apps.AppList.newApp') }}
            </Button>
          </template>
        </EmptyState>
        </div>
      </div>

      <div v-else class="flex flex-col flex-1">

        <!-- Overview and search -->
        <div class="px-4 pt-5 sm:px-6">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 class="text-xl font-semibold text-base-content">{{ t('ui.apps.AppList.containers') }}</h1>
              <p class="mt-1 text-sm text-base-content/70">{{ t('ui.apps.AppList.containersDescription') }}</p>
            </div>
            <Button size="sm" @click="openNew">
              <PlusIcon class="size-4" aria-hidden="true" />
              {{ t('ui.apps.AppList.newApp') }}
            </Button>
          </div>

          <div class="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div class="rounded-lg border border-base-300 bg-base-100 px-4 py-3">
              <strong class="block text-xl tabular-nums text-success">{{ counts.running }}</strong>
              <span class="text-xs text-base-content/70">{{ t('ui.apps.AppList.runningCount') }}</span>
            </div>
            <div class="rounded-lg border border-base-300 bg-base-100 px-4 py-3">
              <strong class="block text-xl tabular-nums">{{ counts.stopped }}</strong>
              <span class="text-xs text-base-content/70">{{ t('ui.apps.AppList.stoppedCount') }}</span>
            </div>
            <div class="rounded-lg border border-base-300 bg-base-100 px-4 py-3">
              <strong class="block text-xl tabular-nums text-warning">{{ counts.pending }}</strong>
              <span class="text-xs text-base-content/70">{{ t('ui.apps.AppList.pendingCount') }}</span>
            </div>
          </div>

          <Alert v-if="loadError" variant="destructive" class="mt-3 flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
            <div class="flex min-w-0 items-start gap-2"><TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" /><AlertDescription>{{ t('ui.apps.AppList.loadFailed') }} {{ loadError }}</AlertDescription></div>
            <Button variant="outline" size="xs" class="shrink-0 border-error/40 text-error hover:bg-error/10" :disabled="loading" @click="load">
              <RefreshCwIcon :class="['size-3.5', loading && 'animate-spin']" aria-hidden="true" />
              {{ t('ui.apps.AppList.retry') }}
            </Button>
          </Alert>

          <div class="relative mt-3 max-w-md">
            <SearchIcon class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-base-content/60" aria-hidden="true" />
            <Input v-model="search" class="pl-9" :placeholder="t('ui.apps.AppList.searchApps')" :aria-label="t('ui.apps.AppList.searchApps')" />
          </div>
        </div>

        <!-- Quick access -->
        <div v-if="pinnedApps.length && !search.trim()" class="px-6 pt-5 pb-5 border-b border-base-300">
          <p class="text-2xs font-semibold text-base-content/70 uppercase tracking-caps mb-3">{{ t('ui.apps.AppList.quickAccess') }}</p>
          <TransitionGroup tag="div" name="ui-pop" class="pinned-grid relative flex flex-wrap gap-2.5">
            <a
              v-for="app in pinnedApps" :key="app.id"
              :href="safePinnedUrl(app.app?.pinnedUrl) ?? undefined" target="_blank" rel="noopener"
              class="group flex items-center gap-3 px-3.5 py-2.5 bg-base-200 border border-base-300 rounded-xl hover:bg-base-200 transition-all no-underline"
            >
              <span :class="['w-2 h-2 rounded-full flex-shrink-0', statusDot(app.status)]" />
              <div class="min-w-0">
                <p class="text-sm font-semibold text-base-content font-mono leading-none">{{ app.name }}</p>
                <p class="text-2xs text-base-content/70 mt-0.5 truncate max-w-[180px]">{{ safePinnedUrl(app.app?.pinnedUrl) }}</p>
              </div>
              <ExternalLinkIcon class="w-3.5 h-3.5 text-base-content/70 group-hover:text-base-content/80 transition-colors flex-shrink-0" aria-hidden="true" />
            </a>
          </TransitionGroup>
        </div>

        <!-- Mobile cards -->
        <div v-if="visibleApps.length === 0 && apps.length > 0" class="flex flex-1 items-center justify-center px-6 py-12 text-center text-sm text-base-content/70">
          {{ t('ui.apps.AppList.noSearchResults', { p0: search }) }}
        </div>

        <div v-else-if="visibleApps.length === 0 && loadError" class="px-6 py-8 text-center text-sm text-base-content/70">
          {{ t('ui.apps.AppList.containersUnavailable') }}
        </div>

        <!-- Mobile cards -->
        <div v-else-if="narrow" class="space-y-2 px-3 pb-3">
          <article v-for="app in visibleApps" :key="app.id" :data-app-name="app.name" :class="['rounded-xl border border-base-300 p-3 transition-colors', focusedName === app.name ? 'bg-primary/10' : 'bg-base-100']">
            <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><div class="flex items-center gap-2 flex-wrap"><strong class="block truncate font-mono text-sm text-base-content">{{app.name}}</strong><Badge variant="outline" v-if="holdForApp(app.name)" class="border-error/40 bg-error/10 text-error">{{ t('ui.apps.AppList.blocked') }}</Badge><Badge variant="outline" v-if="app.catalogUpdate" class="border-warning/40 bg-warning/10 text-warning" :title="`${updateText(app.catalogUpdate)}. Update it from the App Store.`">{{ t('ui.apps.AppList.update') }}</Badge><Badge v-if="app.pendingApply" variant="outline" class="border-warning/40 bg-warning/10 text-warning">{{ t('ui.apps.AppList.changesPending') }}</Badge><Badge v-else-if="app.drifted" variant="outline" class="border-warning/40 bg-warning/10 text-warning">{{ t('ui.apps.AppList.modifiedOutsideHsi') }}</Badge><Badge variant="outline" :class="statusText(app.status).cls">{{ statusText(app.status).label }}</Badge><Badge v-if="pendingJobAction(app.name)" variant="outline" class="border-warning/40 bg-warning/10 text-warning"><LoadingSpinner />{{ actionText(pendingJobAction(app.name)!) }}</Badge></div><p class="mt-1 truncate font-mono text-2xs text-base-content/70" :title="app.app?.image">{{app.app?.image ?? '-'}}</p><p class="mt-1 text-xs text-base-content/70">{{portsSummary(app)}}</p><div v-if="app.services && app.services.length > 1" class="mt-1.5 flex flex-col gap-0.5"><div v-for="svc in app.observed" :key="svc.name" class="flex items-center gap-1.5"><span :class="['w-1 h-1 rounded-full',statusDot(svc.status)]"/><span class="font-mono text-2xs text-base-content/70">{{svc.name}}</span></div></div></div><Button variant="ghost" size="icon" class="touch-target shrink-0 text-base-content/70" :aria-label="t('ui.apps.AppList.editContainer')" :disabled="appHasPendingJob(app.name)" @click="openEdit(app)"><EllipsisIcon /></Button></div>
            <div v-if="appHasPendingJob(app.name)" class="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-base-300 pt-2 text-xs" role="status">
              <span class="inline-flex items-center gap-1.5 text-warning"><LoadingSpinner />{{ actionText(pendingJobAction(app.name)!) }} · {{ t('ui.apps.AppList.jobPending') }}</span>
              <Button variant="outline" size="xs" :disabled="!!actionLoading[app.id]" @click="checkPendingJob(app)">
                <LoadingSpinner v-if="actionLoading[app.id] === 'check'" />{{ actionLoading[app.id] === 'check' ? t('ui.apps.AppList.checkingStatus') : t('ui.apps.AppList.checkStatus') }}
              </Button>
            </div>
            <div v-if="actionLoading[app.id] && actionLoading[app.id] !== 'check'" class="mt-2 flex items-center gap-2 text-xs text-info" role="status"><LoadingSpinner />{{ actionText(actionLoading[app.id]!) }}</div>
            <div class="mt-3 flex flex-wrap gap-1 border-t border-base-300 pt-2">
              <Button v-if="app.pendingApply || app.drifted" variant="outline" size="sm" class="touch-target text-warning" :disabled="!!actionLoading[app.id] || appHasPendingJob(app.name)" @click="applyApp(app.id)">{{ actionLoading[app.id] === 'apply' ? t('ui.apps.AppList.applying') : t('ui.apps.AppList.apply') }}</Button>
              <Button variant="ghost" size="sm" class="touch-target text-success" :disabled="!!actionLoading[app.id] || appHasPendingJob(app.name)" @click="runAction(app.id,'start')">{{ t('ui.apps.AppList.start') }}</Button>
              <Button variant="ghost" size="sm" class="touch-target text-warning" :disabled="!!actionLoading[app.id] || appHasPendingJob(app.name)" @click="runAction(app.id,'stop')">{{ t('ui.apps.AppList.stop') }}</Button>
              <Button variant="ghost" size="sm" class="touch-target text-base-content/80" :disabled="!!actionLoading[app.id] || appHasPendingJob(app.name)" @click="runAction(app.id,'restart')">{{ t('ui.apps.AppList.restart') }}</Button>
              <Button variant="ghost" size="sm" class="touch-target text-base-content/80" @click="openLogs(app)">{{ t('ui.apps.AppList.logs') }}</Button>
            </div>
          </article>
        </div>

        <!-- Desktop table -->
        <div v-else class="overflow-x-auto">
        <Table class="w-full text-sm">
          <TableHeader>
            <TableRow class="border-b border-base-300">
              <TableHead class="text-left px-6 py-2.5 text-2xs font-semibold text-base-content/70 uppercase tracking-caps">{{ t('ui.apps.AppList.container') }}</TableHead>
              <TableHead class="text-left px-3 py-2.5 text-2xs font-semibold text-base-content/70 uppercase tracking-caps hidden md:table-cell">{{ t('ui.apps.AppList.ports') }}</TableHead>
              <TableHead class="text-left px-3 py-2.5 text-2xs font-semibold text-base-content/70 uppercase tracking-caps">{{ t('ui.apps.AppList.status') }}</TableHead>
              <TableHead class="px-6 py-2.5 text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody class="divide-y divide-base-300">
            <TableRow
              v-for="app in visibleApps" :key="app.id"
              :data-app-name="app.name"
              :class="['group transition-colors', focusedName === app.name ? 'bg-primary/10' : 'hover:bg-base-200']"
            >
              <!-- Name -->
              <TableCell class="px-6 py-3.5">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-base-content/80 text-sm font-medium">{{ app.name }}</span>
                  <Tip v-if="holdForApp(app.name)" :text="`Stopped by HSI: ${holdLabel(holdForApp(app.name)!)}`"><Badge variant="outline" class="bg-error/10 text-error">{{ t('ui.apps.AppList.blocked') }}</Badge></Tip>
                  <span v-if="app.catalogUpdate" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-warning border-warning/40" :title="`${updateText(app.catalogUpdate)}. Update it from the App Store.`">{{ t('ui.apps.AppList.update') }}</span>
                  <BookmarkIcon v-if="app.app?.pinnedUrl" class="w-3 h-3 text-primary flex-shrink-0" aria-hidden="true" />
                  <Badge v-if="app.pendingApply" variant="outline" class="border-warning/40 bg-warning/10 text-warning">{{ t('ui.apps.AppList.changesPending') }}</Badge>
                  <Badge v-else-if="app.drifted" variant="outline" class="border-warning/40 bg-warning/10 text-warning">{{ t('ui.apps.AppList.modifiedOutsideHsi') }}</Badge>
                </div>
                <p v-if="app.app?.image" class="mt-1 truncate font-mono text-2xs text-base-content/60" :title="app.app.image">{{ app.app.image }}</p>
                <div v-if="app.services && app.services.length > 1" class="mt-1.5 flex flex-col gap-0.5">
                  <div v-for="svc in app.observed" :key="svc.name" class="flex items-center gap-1.5">
                    <span :class="['w-1 h-1 rounded-full', statusDot(svc.status)]" />
                    <span class="font-mono text-2xs text-base-content/70">{{ svc.name }}</span>
                  </div>
                </div>
              </TableCell>

              <!-- Ports -->
              <TableCell class="px-3 py-3.5 hidden md:table-cell">
                <span class="font-mono text-base-content/70 text-xs">{{ portsSummary(app) }}</span>
              </TableCell>

              <!-- Status -->
              <TableCell class="px-3 py-3.5">
                <Badge variant="outline" :class="statusText(app.status).cls">{{ statusText(app.status).label }}</Badge>
              </TableCell>

              <!-- Actions -->
              <TableCell class="px-6 py-3.5">
                <div class="flex items-center justify-end gap-1">

                  <span v-if="actionLoading[app.id]" role="status" class="mr-1 inline-flex items-center gap-1.5 text-2xs text-info">
                    <LoadingSpinner />{{ actionText(actionLoading[app.id]!) }}
                  </span>

                  <!-- Apply -->
                  <Button v-if="appHasPendingJob(app.name)" variant="outline" size="xs"
                    :disabled="!!actionLoading[app.id]"
                    @click="checkPendingJob(app)"
                  >
                    <LoadingSpinner v-if="actionLoading[app.id] === 'check'" />
                    {{ actionLoading[app.id] === 'check' ? t('ui.apps.AppList.checkingStatus') : t('ui.apps.AppList.checkStatus') }}
                  </Button>

                  <Button variant="outline" size="xs"
                    v-if="app.pendingApply || app.drifted"
                    @click="applyApp(app.id)"
                    :disabled="!!actionLoading[app.id] || appHasPendingJob(app.name)"
                    :tooltip="t('ui.apps.AppList.applyChanges')"
                    class="mr-1.5 text-2xs text-primary border-primary/40"
                  >
                    {{ t('ui.apps.AppList.apply') }}
                  </Button>

                  <!-- Start / Stop / Restart -->
                  <ButtonGroup class="mr-1.5" :aria-label="t('ui.apps.AppList.containerActions')">
                    <Button variant="outline" size="icon-sm" :disabled="!!actionLoading[app.id] || appHasPendingJob(app.name)" :tooltip="t('ui.apps.AppList.start')" :aria-label="t('ui.apps.AppList.start')" class="text-base-content/70 hover:text-success" @click="runAction(app.id, 'start')">
                      <PlayIcon class="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button variant="outline" size="icon-sm" :disabled="!!actionLoading[app.id] || appHasPendingJob(app.name)" :tooltip="t('ui.apps.AppList.stop')" :aria-label="t('ui.apps.AppList.stop')" class="text-base-content/70 hover:text-warning" @click="runAction(app.id, 'stop')">
                      <SquareIcon class="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button variant="outline" size="icon-sm" :disabled="!!actionLoading[app.id] || appHasPendingJob(app.name)" :tooltip="t('ui.apps.AppList.restart')" :aria-label="t('ui.apps.AppList.restart')" class="text-base-content/70 hover:text-primary" @click="runAction(app.id, 'restart')">
                      <RefreshCwIcon class="size-3.5" aria-hidden="true" />
                    </Button>
                  </ButtonGroup>

                  <!-- Logs -->
                  <Button variant="ghost" size="icon-sm"
                    @click="openLogs(app)"
                    :tooltip="t('ui.apps.AppList.logs')" :aria-label="t('ui.apps.AppList.logs')"
                    class="text-base-content/70 hover:text-base-content"
                  >
                    <ScrollTextIcon class="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>

                  <!-- Pin -->
                  <Button variant="ghost" size="icon-sm"
                    @click="app.app?.pinnedUrl ? unpin(app) : openPinDialog(app)"
                    :tooltip="app.app?.pinnedUrl ? 'Unpin from quick access' : 'Pin to quick access'" :aria-label="app.app?.pinnedUrl ? 'Unpin from quick access' : 'Pin to quick access'"
                    :aria-pressed="!!app.app?.pinnedUrl"
                    :class="app.app?.pinnedUrl ? 'text-primary' : 'text-base-content/70'"
                  >
                    <BookmarkIcon class="size-3.5" :fill="app.app?.pinnedUrl ? 'currentColor' : 'none'" aria-hidden="true" />
                  </Button>

                  <!-- Edit -->
                  <Button variant="ghost" size="icon-sm"
                    @click="openEdit(app)"
                    :disabled="appHasPendingJob(app.name)"
                    :tooltip="t('ui.apps.AppList.edit')" :aria-label="t('ui.apps.AppList.edit')"
                    class="text-base-content/70 hover:text-base-content"
                  >
                    <SquarePenIcon class="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>

                  <!-- Delete -->
                  <Button variant="ghost" size="icon-sm"
                    @click="runAction(app.id, 'delete')"
                    :disabled="!!actionLoading[app.id] || appHasPendingJob(app.name)"
                    :tooltip="t('ui.apps.AppList.delete')" :aria-label="t('ui.apps.AppList.delete')"
                    class="text-base-content/70 hover:text-primary"
                  >
                    <Trash2Icon class="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        </div>

      </div>

      <!-- Unmanaged containers: inside the scrollable column so it doesn't
           appear as a fragment sibling in the parent flex row -->
      <UnmanagedContainers v-if="!loading" @imported="load" />
    </div>
  </div>

  <!-- Container logs -->
  <ContainerLogsPanel
    v-if="logsApp"
    :name="logsApp.name"
    @close="logsApp = null"
  />

  <!-- Pin dialog -->
  <Modal v-if="pinDialog" panel-class="w-full max-w-sm" @close="pinDialog = null">
    <template #header>
      <h3 class="text-sm font-semibold text-base-content">
        {{ t('ui.apps.AppList.pin') }} <span class="text-primary">{{ pinDialog.name }}</span> {{ t('ui.apps.AppList.toQuickAccess') }}
      </h3>
    </template>

    <div class="p-5 space-y-1.5">
      <label class="text-xs text-base-content/70">URL</label>
      <Input
        v-model="pinDialogUrl"
        placeholder="http://192.168.1.x:8080"
        @keydown.enter.prevent="savePin"
        @keydown.escape="pinDialog = null"
        autofocus
        class="w-full px-3 py-2 text-sm font-mono"
      />
                  <Alert v-if="pinDialogErr" variant="destructive" class="mt-2"><TriangleAlertIcon /><AlertDescription>{{ pinDialogErr }}</AlertDescription></Alert>
    </div>

    <template #footer>
      <div class="flex-1" />
      <Button variant="ghost" size="sm" @click="pinDialog = null">{{ t('ui.apps.AppList.cancel') }}</Button>
      <Button size="sm"
        @click="savePin"
        :disabled="pinDialogBusy || !pinDialogUrl.trim()"
      >{{ pinDialogBusy ? 'Saving…' : 'Pin' }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
/* Take leaving cards out of the flow so the remaining ones reflow (ui-pop-move)
   immediately instead of waiting for the leave animation to finish. */
.pinned-grid > .ui-pop-leave-active {
  position: absolute;
}
</style>
