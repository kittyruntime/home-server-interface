<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Tip from '../ui/Tip.vue'
import { BookmarkIcon, EllipsisIcon, SquareIcon, ExternalLinkIcon, PackageIcon, PlayIcon, PlusIcon, StoreIcon, RefreshCwIcon, ScrollTextIcon, SquarePenIcon, Trash2Icon, TriangleAlertIcon, CheckIcon } from '@lucide/vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import AppTile from '../store/AppTile.vue'
import SearchInput from '../ui/SearchInput.vue'
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useVolumeHolds, holdLabel } from '../../lib/volumes'
import AppFormModal from './AppFormModal.vue'
import AppListSkeleton from './AppListSkeleton.vue'
import NewAppDialog from './NewAppDialog.vue'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { safePinnedUrl } from '../../lib/pinned-url'
import { portUrl } from '../../lib/port-links'
import { filterApps, summarizeApps } from '../../lib/app-list'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { clearAppJob, knownAppJobs, registerAppJob, type PendingAppJob } from '../../lib/app-jobs'
import { usePoll } from '../../lib/poll'


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

// Catalog logos and names, for the apps installed from the App Store (their
// stack carries the hsi.catalog.id label). Others show their initial.
const catalog = ref<Record<string, { icon: string; name: string }>>({})
async function loadCatalog() {
  try {
    const list = await trpc.catalog.list.query()
    catalog.value = Object.fromEntries(list.map(a => [a.id, { icon: a.icon, name: a.name }]))
  } catch { /* initials only */ }
}
function catalogOf(app: App) {
  const id = app.app?.labels?.find(l => l.key === 'hsi.catalog.id')?.value
  return id ? catalog.value[id] ?? null : null
}
const busyFor = (app: App) => !!actionLoading.value[app.id] || appHasPendingJob(app.name)
function openApp(app: App) {
  const url = openUrl(app)
  if (url) window.open(url, '_blank', 'noopener')
}

onMounted(async () => {
  void refreshHolds()
  void loadCatalog()
  void loadLanHost()
  await load()
})
// Container states change behind our back (crash, restart policy, the CLI).
usePoll(silentRefresh, 10_000, { immediate: false })

onUnmounted(() => {
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
    case 'running':       return { label: t('uis.apps.AppList.running'),  cls: 'text-success' }
    case 'stopped':       return { label: t('uis.apps.AppList.stopped'),  cls: 'text-base-content/70' }
    case 'error':         return { label: t('uis.apps.AppList.error'),    cls: 'text-error' }
    case 'transitioning': return { label: t('uis.apps.AppList.updating'), cls: 'text-warning' }
    default:              return { label: t('uis.apps.AppList.unknown'),  cls: 'text-base-content/70' }
  }
}

function actionText(action: string) {
  return t(`ui.apps.AppList.action${action.charAt(0).toUpperCase()}${action.slice(1)}`)
}

// Published ports open the app from the local network: on the server's LAN
// address, as HSI itself may be reached through a domain or a proxy.
const lanHost = ref(location.hostname)
async function loadLanHost() {
  try {
    const { address } = await trpc.container.app.lanAddress.query()
    if (address) lanHost.value = address
  } catch { /* the address HSI is opened at */ }
}
const shownPorts = (app: App) => (app.app?.ports ?? []).slice(0, 3)
const hiddenPorts = (app: App) => Math.max(0, (app.app?.ports?.length ?? 0) - 3)

/** Where Open goes: the pinned URL, else the first port that is a link. */
function openUrl(app: App): string | null {
  const pinned = safePinnedUrl(app.app?.pinnedUrl)
  if (pinned) return pinned
  if (app.status !== 'running') return null
  for (const p of app.app?.ports ?? []) {
    const url = portUrl(p, lanHost.value)
    if (url) return url
  }
  return null
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

// Adding by hand starts with a choice (one app, or services from a Compose
// file); the form opens for the first.
const choosing = ref(false)
function openNew()        { choosing.value = true }
function openForm()       { editName.value = null; showModal.value = true }

// Services added from a Compose file: show them, and start them when asked
// (the start goes through its preview like any other).
async function onComposeAdded(name: string, start: boolean) {
  await load()
  await markApp(name)
  if (start) void runAction(name, 'start')
}

// An app created in the form: back to the list, which marks it and follows
// its start (requested by the form) like any other.
async function onCreated(name: string) {
  showModal.value = false
  await load()
  await markApp(name)
  followStart(name)
}

/** Mark a listed app for a few seconds and scroll it into view. */
async function markApp(name: string) {
  focusedName.value = name
  if (focusTimer) clearTimeout(focusTimer)
  focusTimer = setTimeout(() => { focusedName.value = null }, 4000)
  await nextTick()
  for (const el of document.querySelectorAll<HTMLElement>(`[data-app-name="${CSS.escape(name)}"]`)) {
    if (el.offsetParent) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
}

/** Follow the start job a new app was created with, if any. */
function followStart(name: string) {
  const job = knownAppJobs.get(name)
  if (job) void observePendingJob(job)
}
// Multi-service stacks are fine too: the form modal handles them with a
// notice + the raw YAML editor (advanced tab only). Pinning from the UI is
// guarded server-side.
function openEdit(a: App) {
  editName.value = a.name
  showModal.value = true
}
function openLogs(a: App) { logsApp.value = a }

// A freshly installed app (#36): once listed, scroll to it, mark it for a
// few seconds and follow its start in the list.
const focusedName = ref<string | null>(null)
let focusTimer: ReturnType<typeof setTimeout> | null = null
watch([pendingAppFocus, apps], async () => {
  const app = appToFocus(pendingAppFocus.value, apps.value)
  if (!app) return
  pendingAppFocus.value = null
  followStart(app.name)
  await markApp(app.name)
})
// Already mounted: pick the new app up without waiting for the next refresh.
watch(pendingAppFocus, name => { if (name && !loading.value) void silentRefresh() })

defineExpose({ openNew })
const emit = defineEmits<{ browseStore: [] }>()

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

  <!-- Inline form (create / edit): replaces the list when active -->
  <AppFormModal
    v-if="showModal"
    :edit-name="editName"
    @close="showModal = false"
    @saved="onSaved"
    @deployed="onDeployed"
    @created="onCreated"
  />

  <div v-else class="flex-1 overflow-y-auto min-w-0">
    <div class="mx-auto w-full max-w-5xl px-4 py-5 sm:px-8 sm:py-8">

      <AppListSkeleton v-if="loading && !apps.length" />

      <!-- Empty state -->
      <div v-else-if="apps.length === 0 && !loadError" class="flex min-h-[60vh] items-center justify-center">
        <EmptyState
          :message="t('ui.apps.AppList.noContainersYet')"
          :description="t('ui.apps.AppList.startFromTheStore')"
        >
          <template #icon>
            <span class="grid size-16 place-items-center rounded-[23%] bg-base-200 text-base-content/60">
              <PackageIcon class="size-8" aria-hidden="true" />
            </span>
          </template>
          <template #action>
            <div class="flex flex-wrap justify-center gap-2">
              <Button @click="emit('browseStore')"><StoreIcon class="size-4" aria-hidden="true" />{{ t('ui.apps.AppList.browseTheStore') }}</Button>
              <Button variant="outline" @click="openNew"><PlusIcon class="size-4" aria-hidden="true" />{{ t('ui.apps.AppList.newApp') }}</Button>
            </div>
          </template>
        </EmptyState>
      </div>

      <div v-else class="content-in">
        <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div class="min-w-0">
            <h1 class="text-2xl font-semibold tracking-tight text-base-content">{{ t('ui.apps.AppList.installedApps') }}</h1>
            <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-base-content/70 tabular-nums">
              <span class="inline-flex items-center gap-1.5"><span class="size-1.5 rounded-full bg-success" />{{ t('ui.apps.AppList.runningSummary', { p0: counts.running }) }}</span>
              <span class="inline-flex items-center gap-1.5"><span class="size-1.5 rounded-full bg-base-content/50" />{{ t('ui.apps.AppList.stoppedSummary', { p0: counts.stopped }) }}</span>
              <span v-if="counts.pending" class="inline-flex items-center gap-1.5 text-warning"><span class="size-1.5 rounded-full bg-warning" />{{ t('ui.apps.AppList.pendingSummary', { p0: counts.pending }) }}</span>
            </p>
          </div>
          <SearchInput v-model="search" :placeholder="t('ui.apps.AppList.searchApps')" :aria-label="t('ui.apps.AppList.searchApps')" class="sm:w-72" />
        </header>

        <Alert v-if="loadError" variant="destructive" class="mt-5 flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
          <div class="flex min-w-0 items-start gap-2"><TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" /><AlertDescription>{{ t('ui.apps.AppList.loadFailed') }} {{ loadError }}</AlertDescription></div>
          <Button variant="outline" size="xs" class="shrink-0 border-error/40 text-error hover:bg-error/10" :disabled="loading" @click="load">
            <RefreshCwIcon :class="['size-3.5', loading && 'animate-spin']" aria-hidden="true" />
            {{ t('ui.apps.AppList.retry') }}
          </Button>
        </Alert>

        <!-- Quick access: the pinned addresses, as a shelf of icons -->
        <section v-if="pinnedApps.length && !search.trim()" class="mt-7" :aria-label="t('ui.apps.AppList.quickAccess')">
          <h2 class="text-lg font-semibold tracking-tight text-base-content">{{ t('ui.apps.AppList.quickAccess') }}</h2>
          <TransitionGroup tag="div" name="ui-pop" class="pinned-grid relative mt-3 flex flex-wrap gap-2">
            <a
              v-for="app in pinnedApps" :key="app.id"
              :href="safePinnedUrl(app.app?.pinnedUrl) ?? undefined" target="_blank" rel="noopener"
              :title="safePinnedUrl(app.app?.pinnedUrl) ?? undefined"
              class="group flex w-24 flex-col items-center gap-2 rounded-box px-2 py-3 text-center no-underline transition-colors hover:bg-base-200 focus-visible:bg-base-200 focus-visible:outline-none"
            >
              <span class="relative">
                <AppTile :svg="catalogOf(app)?.icon" :name="catalogOf(app)?.name ?? app.name" size="lg" />
                <span :class="['absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-base-100', statusDot(app.status)]" />
              </span>
              <span class="w-full truncate text-xs text-base-content/80 group-hover:text-base-content">{{ catalogOf(app)?.name ?? app.name }}</span>
            </a>
          </TransitionGroup>
        </section>

        <div v-if="visibleApps.length === 0 && apps.length > 0" class="py-16 text-center text-sm text-base-content/70">
          {{ t('ui.apps.AppList.noSearchResults', { p0: search }) }}
        </div>

        <div v-else-if="visibleApps.length === 0 && loadError" class="py-10 text-center text-sm text-base-content/70">
          {{ t('ui.apps.AppList.containersUnavailable') }}
        </div>

        <section v-else class="mt-7" :aria-label="t('ui.apps.AppList.containers')">
          <h2 v-if="pinnedApps.length && !search.trim()" class="mb-3 text-lg font-semibold tracking-tight text-base-content">{{ t('ui.apps.AppList.allApps') }}</h2>
          <ul class="overflow-hidden rounded-box border border-base-300 bg-base-100">
            <li
              v-for="app in visibleApps" :key="app.id"
              :data-app-name="app.name"
              :class="['row relative flex items-center gap-3.5 px-4 py-3 transition-colors', focusedName === app.name ? 'bg-primary/10' : '']"
            >
              <AppTile :svg="catalogOf(app)?.icon" :name="catalogOf(app)?.name ?? app.name" />

              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <button type="button"
                    class="truncate text-left text-sm font-semibold text-base-content outline-none hover:underline focus-visible:underline disabled:no-underline pointer-coarse:-my-3 pointer-coarse:py-3"
                    :class="!catalogOf(app) && 'font-mono font-medium'"
                    :disabled="appHasPendingJob(app.name)"
                    :aria-label="`${t('ui.apps.AppList.edit')} ${app.name}`"
                    @click="openEdit(app)">{{ catalogOf(app)?.name ?? app.name }}</button>
                  <Tip v-if="holdForApp(app.name)" :text="`Stopped by HSI: ${holdLabel(holdForApp(app.name)!)}`"><span class="badge badge-sm badge-soft badge-error whitespace-nowrap">{{ t('ui.apps.AppList.blocked') }}</span></Tip>
                  <span v-if="app.catalogUpdate" class="badge badge-sm badge-soft badge-warning whitespace-nowrap" :title="`${updateText(app.catalogUpdate)}. Update it from the App Store.`">{{ t('ui.apps.AppList.update') }}</span>
                  <span v-if="app.pendingApply" class="badge badge-sm badge-soft badge-warning whitespace-nowrap">{{ t('ui.apps.AppList.changesPending') }}</span>
                  <span v-else-if="app.drifted" class="badge badge-sm badge-soft badge-warning whitespace-nowrap">{{ t('ui.apps.AppList.modifiedOutsideHsi') }}</span>
                </div>
                <p class="mt-0.5 truncate font-mono text-2xs text-base-content/60" :title="app.app?.image ?? undefined">
                  <template v-if="catalogOf(app)">{{ app.name }} · </template>{{ app.app?.image ?? '-' }}<template v-for="p in shownPorts(app)" :key="`${p.hostPort}/${p.protocol}`"> · <a
                    v-if="portUrl(p, lanHost)" :href="portUrl(p, lanHost)!" target="_blank" rel="noopener noreferrer"
                    class="touch-hit link link-hover text-primary" :title="portUrl(p, lanHost)!"
                    :aria-label="`${t('ui.apps.AppList.openPort', { p0: p.hostPort })}: ${app.name}`">{{ p.hostPort }}</a><template v-else>{{ p.hostPort }}/{{ p.protocol }}</template></template><template v-if="hiddenPorts(app)"> +{{ hiddenPorts(app) }}</template>
                </p>
                <p v-if="app.services && app.services.length > 1" class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span v-for="svc in app.observed" :key="svc.name" class="inline-flex items-center gap-1.5 font-mono text-2xs text-base-content/70">
                    <span :class="['size-1.5 rounded-full', statusDot(svc.status)]" />{{ svc.name }}
                  </span>
                </p>
                <p v-if="appHasPendingJob(app.name)" role="status" class="mt-1 inline-flex items-center gap-1.5 text-xs text-warning">
                  <LoadingSpinner />{{ actionText(pendingJobAction(app.name)!) }} · {{ t('ui.apps.AppList.jobPending') }}
                </p>
                <p v-else-if="actionLoading[app.id] && actionLoading[app.id] !== 'check'" role="status" class="mt-1 inline-flex items-center gap-1.5 text-xs text-info">
                  <LoadingSpinner />{{ actionText(actionLoading[app.id]!) }}
                </p>
              </div>

              <span class="hidden w-24 shrink-0 items-center gap-1.5 text-xs sm:inline-flex" :class="statusText(app.status).cls">
                <span :class="['size-1.5 shrink-0 rounded-full', statusDot(app.status)]" />{{ statusText(app.status).label }}
              </span>

              <!-- One action for the state the app is in; the rest in the menu. -->
              <div class="flex shrink-0 items-center gap-1">
                <div class="flex justify-end sm:min-w-28">
                <Button v-if="appHasPendingJob(app.name)" variant="secondary" size="sm" :disabled="!!actionLoading[app.id]" @click="checkPendingJob(app)">
                  <LoadingSpinner v-if="actionLoading[app.id] === 'check'" />{{ actionLoading[app.id] === 'check' ? t('ui.apps.AppList.checkingStatus') : t('ui.apps.AppList.checkStatus') }}
                </Button>
                <Button v-else-if="app.pendingApply || app.drifted" size="sm" class="btn-soft min-w-20" :disabled="busyFor(app)" :tooltip="t('ui.apps.AppList.applyChanges')" @click="applyApp(app.id)">{{ t('ui.apps.AppList.apply') }}</Button>
                <Button v-else-if="app.status === 'stopped' || app.status === 'error'" variant="secondary" size="sm" class="min-w-20" :disabled="busyFor(app)" @click="runAction(app.id, 'start')">{{ t('ui.apps.AppList.start') }}</Button>
                <Button v-else-if="openUrl(app)" variant="secondary" size="sm" class="min-w-20" :tooltip="openUrl(app)!" @click="openApp(app)">
                  {{ t('ui.apps.AppList.open') }}<ExternalLinkIcon class="size-3.5 opacity-60" aria-hidden="true" />
                </Button>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="icon-sm" class="touch-target text-base-content/70" :aria-label="`${t('ui.apps.AppList.containerActions')}: ${app.name}`">
                      <EllipsisIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="min-w-[200px]">
                    <DropdownMenuItem :disabled="busyFor(app)" @select="runAction(app.id, 'start')"><PlayIcon />{{ t('ui.apps.AppList.start') }}</DropdownMenuItem>
                    <DropdownMenuItem :disabled="busyFor(app)" @select="runAction(app.id, 'stop')"><SquareIcon />{{ t('ui.apps.AppList.stop') }}</DropdownMenuItem>
                    <DropdownMenuItem :disabled="busyFor(app)" @select="runAction(app.id, 'restart')"><RefreshCwIcon />{{ t('ui.apps.AppList.restart') }}</DropdownMenuItem>
                    <DropdownMenuItem v-if="app.pendingApply || app.drifted" :disabled="busyFor(app)" @select="applyApp(app.id)"><CheckIcon />{{ t('ui.apps.AppList.applyChanges') }}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem @select="openLogs(app)"><ScrollTextIcon />{{ t('ui.apps.AppList.logs') }}</DropdownMenuItem>
                    <DropdownMenuItem @select="app.app?.pinnedUrl ? unpin(app) : openPinDialog(app)">
                      <BookmarkIcon />{{ app.app?.pinnedUrl ? t('ui.apps.AppList.unpinQuickAccess') : t('ui.apps.AppList.pinQuickAccess') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="appHasPendingJob(app.name)" @select="openEdit(app)"><SquarePenIcon />{{ t('ui.apps.AppList.edit') }}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" :disabled="busyFor(app)" @select="runAction(app.id, 'delete')"><Trash2Icon />{{ t('ui.apps.AppList.delete') }}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <!-- Containers HSI does not manage yet -->
      <UnmanagedContainers v-if="!loading" class="mt-8" @imported="load" />
    </div>
  </div>
  </div>

  <NewAppDialog
    v-if="choosing"
    @close="choosing = false"
    @single="openForm"
    @store="emit('browseStore')"
    @created="onComposeAdded"
  />

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
/* Hairlines between rows, from the text edge as in a grouped list. */
.row + .row::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  left: 4.625rem;
  border-top: 1px solid color-mix(in oklab, var(--color-base-content) 10%, transparent);
}

/* Take leaving cards out of the flow so the remaining ones reflow (ui-pop-move)
   immediately instead of waiting for the leave animation to finish. */
.pinned-grid > .ui-pop-leave-active {
  position: absolute;
}
</style>
