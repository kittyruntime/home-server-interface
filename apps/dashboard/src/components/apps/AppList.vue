<script setup lang="ts">
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useVolumeHolds, holdLabel } from '../../lib/volumes'
import AppFormModal from './AppFormModal.vue'
import ContainerLogsPanel from './ContainerLogsPanel.vue'
import UnmanagedContainers from './UnmanagedContainers.vue'
import Modal from '../ui/Modal.vue'
import EmptyState from '../ui/EmptyState.vue'
import { pollJobResult, JobError } from '../../lib/jobs'
import { viewableJobId, viewLogsAction } from '../../lib/jobLogs'
import { useNotifications } from '../../lib/notifications'
import { useToast } from '../../lib/toast'
import { applyPlannedJob } from '../../lib/plan'
import { pendingAppFocus, appToFocus } from '../../lib/app-focus'

const { push: pushNotif, update: updateNotif, dismiss: dismissNotif } = useNotifications()
const toast = useToast()

type App = Awaited<ReturnType<typeof trpc.container.app.list.query>>[number]

const apps          = ref<App[]>([])
const loading       = ref(true)
const showModal     = ref(false)
const editName      = ref<string | null>(null)
const actionLoading = ref<Record<string, string>>({})
let   refreshTimer: ReturnType<typeof setInterval> | null = null

const pinDialog     = ref<App | null>(null)
const pinDialogUrl  = ref('')
const pinDialogErr  = ref('')
const pinDialogBusy = ref(false)

const pinnedApps = computed(() => apps.value.filter(a => a.app?.pinnedUrl))

async function load() {
  loading.value = true
  try { apps.value = await trpc.container.app.list.query() }
  catch (e: any) { console.error('Failed to load apps:', e.message) }
  finally { loading.value = false }
}

// Background refresh: no loading toggle: the spinner must show on the initial
// mount only, or the whole panel would flicker (and remount UnmanagedContainers)
// every 10 s.
async function silentRefresh() {
  try { apps.value = await trpc.container.app.list.query() }
  catch { /* keep previous list on error */ }
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
    case 'running':       return 'bg-[var(--c-success)]'
    case 'stopped':       return 'bg-[var(--c-text-3)]'
    case 'error':         return 'bg-[var(--c-accent)]'
    case 'transitioning': return 'bg-[var(--c-warning)] animate-pulse'
    default:              return 'bg-[var(--c-warning)]'
  }
}

function statusText(status: string) {
  switch (status) {
    case 'running':       return { label: 'Running',  cls: 'text-[var(--c-success)]' }
    case 'stopped':       return { label: 'Stopped',  cls: 'text-[var(--c-text-3)]'   }
    case 'error':         return { label: 'Error',    cls: 'text-[var(--c-accent)]'   }
    case 'transitioning': return { label: 'Updating…',cls: 'text-[var(--c-warning)]'  }
    default:              return { label: 'Unknown',  cls: 'text-[var(--c-text-3)]'   }
  }
}

function portsSummary(app: App): string {
  const ports = app.app?.ports ?? []
  if (!ports.length) return '-'
  return ports.slice(0, 2).map(p => `${p.hostPort}:${p.containerPort}`).join(', ')
    + (ports.length > 2 ? ` +${ports.length - 2}` : '')
}

async function runAction(id: string, action: 'start' | 'stop' | 'restart' | 'delete') {
  actionLoading.value[id] = action
  const app = apps.value.find(a => a.id === id)
  const actionLabel = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', delete: 'Deleting' }[action]
  const planned = action === 'start' || action === 'delete'
  const notifId = !planned
    ? pushNotif({ type: 'progress', title: `${actionLabel} ${app?.name ?? ''}…`, progress: -1 })
    : null
  try {
    if (action === 'delete') {
      const jobId = await applyPlannedJob('app.remove', { name: app?.name ?? id }, {
        title: `Delete ${app?.name ?? id}`, actionLabel: 'Delete', danger: true,
      })
      const result = await pollJobResult(jobId)
      // Only drop the row when the job actually completed; on failure the row
      // stays and the error is surfaced.
      if (result.status !== 'completed') throw new JobError(result.error ?? 'Delete failed', jobId)
      apps.value = apps.value.filter(a => a.id !== id)
      return
    }
    const jobId = action === 'start'
      ? await applyPlannedJob('app.start', { name: app?.name ?? id }, { title: `Start ${app?.name ?? id}`, actionLabel: 'Start' })
      : (await trpc.container.app[action].mutate({ name: app?.name ?? id })).jobId
    if (app) app.status = 'transitioning'
    const result = await pollJobResult(jobId)
    if (result.status !== 'completed') throw new JobError(result.error ?? `${action} failed`, jobId)
    if (app) app.status = action === 'start' ? 'running' : 'stopped'
    if (notifId) { updateNotif(notifId, { type: 'success', title: `${app?.name ?? ''} ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'}`, progress: undefined }); setTimeout(() => dismissNotif(notifId), 3000) }
  } catch (e: any) {
    if (planned && e?.message === '') return // cancelled in the plan dialog
    if (app) app.status = 'unknown'
    if (notifId) updateNotif(notifId, { type: 'error', title: `${actionLabel} ${app?.name ?? ''} failed`, detail: e?.message, progress: undefined, jobId: viewableJobId(e) })
    toast.error(e.message ?? `Failed: ${action}`, viewLogsAction(e))
  } finally {
    delete actionLoading.value[id]
  }
}

async function applyApp(id: string) {
  actionLoading.value[id] = 'apply'
  const app = apps.value.find(a => a.id === id)
  let notifId: string | null = null
  try {
    const jobId = await applyPlannedJob('app.apply', { name: app?.name ?? id }, {
      title: `Apply ${app?.name ?? id}`, actionLabel: 'Apply',
    })
    const nid = pushNotif({ type: 'progress', title: `Applying ${app?.name ?? ''}…`, progress: -1 })
    notifId = nid
    const result = await pollJobResult(jobId)
    if (result.status !== 'completed') {
      // Job failed (or timed out): keep the pending badge and surface the error.
      const msg = result.error ?? 'Apply failed'
      const err = new JobError(msg, jobId)
      updateNotif(nid, { type: 'error', title: `Apply ${app?.name ?? ''} failed`, detail: msg, progress: undefined, jobId: viewableJobId(err) })
      toast.error(msg, viewLogsAction(err))
      return
    }
    updateNotif(nid, { type: 'success', title: `${app?.name ?? ''} applied`, progress: undefined })
    setTimeout(() => dismissNotif(nid), 3000)
    // Apply never rewrites the compose file, so the drifted badge must stay
    // until the file is regenerated; only pendingApply is resolved here.
    if (app) app.pendingApply = false
  } catch (e: any) {
    if (e?.message === '') return // cancelled in the plan dialog
    if (notifId) updateNotif(notifId, { type: 'error', title: `Apply ${app?.name ?? ''} failed`, detail: e?.message, progress: undefined })
    toast.error(e?.message ?? 'Failed to apply')
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

function onSaved() { load() }

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
    pinDialogErr.value = e?.message ?? 'Failed to save'
  } finally {
    pinDialogBusy.value = false
  }
}

async function unpin(app: App) {
  try {
    await trpc.container.app.pin.mutate({ name: app.name, pinnedUrl: null })
    if (app.app) app.app.pinnedUrl = null
  } catch (e: any) {
    toast.error(e?.message ?? 'Failed to unpin')
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
  />

  <div v-else class="flex-1 overflow-y-auto flex flex-col min-w-0">

      <!-- Loading -->
      <LoadingState v-if="loading && !apps.length" variant="block" />

      <!-- Empty state -->
      <div v-else-if="apps.length === 0" class="flex-1 flex items-center justify-center px-8">
        <EmptyState
          message="No containers yet"
          description="Deploy your first container to get started. You can configure ports, volumes, environment variables and more."
        >
          <template #icon>
            <div class="w-16 h-16 rounded-xl bg-[var(--c-surface-alt)] border border-[var(--c-border)] flex items-center justify-center">
              <svg class="w-8 h-8 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.25">
                <path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"/>
              </svg>
            </div>
          </template>
          <template #action>
            <button
              @click="openNew"
              class="btn btn-primary"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              New App
            </button>
          </template>
        </EmptyState>
      </div>

      <div v-else class="flex flex-col flex-1">

        <!-- Quick access -->
        <div v-if="pinnedApps.length" class="px-6 pt-5 pb-5 border-b border-[var(--c-border)]">
          <p class="text-2xs font-semibold text-[var(--c-text-3)] uppercase tracking-caps mb-3">Quick access</p>
          <TransitionGroup tag="div" name="ui-pop" class="pinned-grid relative flex flex-wrap gap-2.5">
            <a
              v-for="app in pinnedApps" :key="app.id"
              :href="app.app?.pinnedUrl ?? ''" target="_blank" rel="noopener"
              class="group flex items-center gap-3 px-3.5 py-2.5 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-xl hover:bg-[var(--c-hover)] transition-all no-underline"
            >
              <span :class="['w-2 h-2 rounded-full flex-shrink-0', statusDot(app.status)]" />
              <div class="min-w-0">
                <p class="text-sm font-semibold text-[var(--c-text-1)] font-mono leading-none">{{ app.name }}</p>
                <p class="text-2xs text-[var(--c-text-3)] mt-0.5 truncate max-w-[180px]">{{ app.app?.pinnedUrl }}</p>
              </div>
              <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] group-hover:text-[var(--c-text-2)] transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
              </svg>
            </a>
          </TransitionGroup>
        </div>

        <!-- Mobile cards -->
        <div class="space-y-2 px-3 pb-3 sm:hidden">
          <article v-for="app in apps" :key="app.id" :data-app-name="app.name" :class="['rounded-xl border border-[var(--c-border)] p-3 transition-colors', focusedName === app.name ? 'bg-[var(--c-accent-subtle)]' : 'bg-[var(--c-surface)]']">
            <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><div class="flex items-center gap-2 flex-wrap"><span :class="['h-2 w-2 shrink-0 rounded-full',statusDot(app.status)]"/><strong class="block truncate font-mono text-sm text-[var(--c-text-1)]">{{app.name}}</strong><span v-if="holdForApp(app.name)" class="badge bg-danger/10 text-danger">Blocked</span><span v-if="app.pendingApply" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-[var(--c-accent)] border-[var(--c-accent)]/40">Changes pending</span><span v-else-if="app.drifted" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-[var(--c-warning)] border-[var(--c-warning)]/40">Modified outside HSI</span></div><p class="mt-1 truncate font-mono text-2xs text-[var(--c-text-3)]" :title="app.app?.image">{{app.app?.image ?? '-'}}</p><p class="mt-1 text-xs" :class="statusText(app.status).cls">{{statusText(app.status).label}} · {{portsSummary(app)}}</p><div v-if="app.services && app.services.length > 1" class="mt-1.5 flex flex-col gap-0.5"><div v-for="svc in app.observed" :key="svc.name" class="flex items-center gap-1.5"><span :class="['w-1 h-1 rounded-full',statusDot(svc.status)]"/><span class="font-mono text-2xs text-[var(--c-text-3)]">{{svc.name}}</span></div></div></div><button class="touch-target grid shrink-0 place-items-center rounded-lg text-[var(--c-text-3)]" aria-label="Edit container" @click="openEdit(app)">⋯</button></div>
            <div class="mt-3 grid grid-cols-4 gap-1 border-t border-[var(--c-border)] pt-2"><button class="touch-target rounded-lg text-xs text-success active:bg-[var(--c-hover)]" :disabled="!!actionLoading[app.id]" @click="runAction(app.id,'start')">Start</button><button class="touch-target rounded-lg text-xs text-warning active:bg-[var(--c-hover)]" :disabled="!!actionLoading[app.id]" @click="runAction(app.id,'stop')">Stop</button><button class="touch-target rounded-lg text-xs text-[var(--c-text-2)] active:bg-[var(--c-hover)]" :disabled="!!actionLoading[app.id]" @click="runAction(app.id,'restart')">Restart</button><button class="touch-target rounded-lg text-xs text-[var(--c-text-2)] active:bg-[var(--c-hover)]" @click="openLogs(app)">Logs</button></div>
          </article>
        </div>

        <!-- Desktop table -->
        <div class="hidden overflow-x-auto sm:block">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--c-border)]">
              <th class="text-left px-6 py-2.5 text-2xs font-semibold text-[var(--c-text-3)] uppercase tracking-caps">Container</th>
              <th class="text-left px-3 py-2.5 text-2xs font-semibold text-[var(--c-text-3)] uppercase tracking-caps hidden sm:table-cell">Image</th>
              <th class="text-left px-3 py-2.5 text-2xs font-semibold text-[var(--c-text-3)] uppercase tracking-caps hidden md:table-cell">Ports</th>
              <th class="text-left px-3 py-2.5 text-2xs font-semibold text-[var(--c-text-3)] uppercase tracking-caps">Status</th>
              <th class="px-6 py-2.5 text-right"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--c-border)]">
            <tr
              v-for="app in apps" :key="app.id"
              :data-app-name="app.name"
              :class="['group transition-colors', focusedName === app.name ? 'bg-[var(--c-accent-subtle)]' : 'hover:bg-[var(--c-hover)]']"
            >
              <!-- Name -->
              <td class="px-6 py-3.5">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-[var(--c-text-2)] text-sm font-medium">{{ app.name }}</span>
                  <span v-if="holdForApp(app.name)" class="badge bg-danger/10 text-danger" :title="`Stopped by HSI: ${holdLabel(holdForApp(app.name)!)}`">Blocked</span>
                  <svg
                    v-if="app.app?.pinnedUrl"
                    class="w-3 h-3 text-[var(--c-accent)] flex-shrink-0"
                    fill="currentColor" viewBox="0 0 24 24"
                  >
                    <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/>
                  </svg>
                  <span v-if="app.pendingApply" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-[var(--c-accent)] border-[var(--c-accent)]/40">Changes pending</span>
                  <span v-else-if="app.drifted" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-[var(--c-warning)] border-[var(--c-warning)]/40">Modified outside HSI</span>
                </div>
                <div v-if="app.services && app.services.length > 1" class="mt-1.5 flex flex-col gap-0.5">
                  <div v-for="svc in app.observed" :key="svc.name" class="flex items-center gap-1.5">
                    <span :class="['w-1 h-1 rounded-full', statusDot(svc.status)]" />
                    <span class="font-mono text-2xs text-[var(--c-text-3)]">{{ svc.name }}</span>
                  </div>
                </div>
              </td>

              <!-- Image -->
              <td class="px-3 py-3.5 hidden sm:table-cell">
                <span class="font-mono text-[var(--c-text-3)] text-xs truncate block">{{ app.app?.image ?? '-' }}</span>
              </td>

              <!-- Ports -->
              <td class="px-3 py-3.5 hidden md:table-cell">
                <span class="font-mono text-[var(--c-text-3)] text-xs">{{ portsSummary(app) }}</span>
              </td>

              <!-- Status -->
              <td class="px-3 py-3.5">
                <span class="flex items-center gap-1.5">
                  <span :class="['w-1.5 h-1.5 rounded-full', statusDot(app.status)]" />
                  <span :class="['text-xs', statusText(app.status).cls]">{{ statusText(app.status).label }}</span>
                </span>
              </td>

              <!-- Actions -->
              <td class="px-6 py-3.5">
                <div class="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">

                  <!-- Apply -->
                  <button
                    v-if="app.pendingApply || app.drifted"
                    @click="applyApp(app.id)"
                    :disabled="!!actionLoading[app.id]"
                    title="Apply changes"
                    class="px-2 py-1 mr-1.5 rounded-lg text-2xs font-medium text-[var(--c-accent)] border border-[var(--c-accent)]/40 hover:bg-[var(--c-hover)] disabled:opacity-30 transition-colors"
                  >
                    Apply
                  </button>

                  <!-- Start / Stop / Restart -->
                  <div class="flex items-center border border-[var(--c-border-strong)] rounded-lg overflow-hidden mr-1.5">
                    <button
                      @click="runAction(app.id, 'start')"
                      :disabled="!!actionLoading[app.id]"
                      title="Start"
                      class="px-2 py-1.5 text-[var(--c-text-3)] hover:text-[var(--c-success)] hover:bg-[var(--c-hover)] disabled:opacity-30 transition-colors"
                    >
                      <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M6.3 2.841A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/>
                      </svg>
                    </button>
                    <span class="w-px h-4 bg-[var(--c-border-strong)]" />
                    <button
                      @click="runAction(app.id, 'stop')"
                      :disabled="!!actionLoading[app.id]"
                      title="Stop"
                      class="px-2 py-1.5 text-[var(--c-text-3)] hover:text-[var(--c-warning)] hover:bg-[var(--c-hover)] disabled:opacity-30 transition-colors"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <rect x="6" y="6" width="12" height="12" rx="1"/>
                      </svg>
                    </button>
                    <span class="w-px h-4 bg-[var(--c-border-strong)]" />
                    <button
                      @click="runAction(app.id, 'restart')"
                      :disabled="!!actionLoading[app.id]"
                      title="Restart"
                      class="px-2 py-1.5 text-[var(--c-text-3)] hover:text-[var(--c-accent)] hover:bg-[var(--c-hover)] disabled:opacity-30 transition-colors"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                      </svg>
                    </button>
                  </div>

                  <!-- Logs -->
                  <button
                    @click="openLogs(app)"
                    title="Logs"
                    class="p-1.5 text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors rounded-lg hover:bg-[var(--c-hover)]"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h8"/>
                    </svg>
                  </button>

                  <!-- Pin -->
                  <button
                    @click="app.app?.pinnedUrl ? unpin(app) : openPinDialog(app)"
                    :title="app.app?.pinnedUrl ? 'Unpin from quick access' : 'Pin to quick access'"
                    :class="[
                      'p-1.5 rounded-lg transition-colors hover:bg-[var(--c-hover)]',
                      app.app?.pinnedUrl ? 'text-[var(--c-accent)] hover:text-[var(--c-text-2)]' : 'text-[var(--c-text-3)] hover:text-[var(--c-text-2)]',
                    ]"
                  >
                    <svg class="w-3.5 h-3.5" :fill="app.app?.pinnedUrl ? 'currentColor' : 'none'" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/>
                    </svg>
                  </button>

                  <!-- Edit -->
                  <button
                    @click="openEdit(app)"
                    title="Edit"
                    class="p-1.5 text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors rounded-lg hover:bg-[var(--c-hover)]"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                    </svg>
                  </button>

                  <!-- Delete -->
                  <button
                    @click="runAction(app.id, 'delete')"
                    :disabled="!!actionLoading[app.id]"
                    title="Delete"
                    class="p-1.5 text-[var(--c-text-3)] hover:text-[var(--c-accent)] disabled:opacity-30 transition-colors rounded-lg hover:bg-[var(--c-hover)]"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
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
      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">
        Pin <span class="font-mono text-[var(--c-accent)]">{{ pinDialog.name }}</span> to quick access
      </h3>
    </template>

    <div class="p-5 space-y-1.5">
      <label class="text-xs text-[var(--c-text-3)]">URL</label>
      <input
        v-model="pinDialogUrl"
        placeholder="http://192.168.1.x:8080"
        @keydown.enter.prevent="savePin"
        @keydown.escape="pinDialog = null"
        autofocus
        class="ui-input w-full px-3 py-2 text-sm font-mono"
      />
      <p v-if="pinDialogErr" class="text-xs text-[var(--c-accent)]">{{ pinDialogErr }}</p>
    </div>

    <template #footer>
      <div class="flex-1" />
      <button @click="pinDialog = null" class="btn btn-ghost btn-sm">Cancel</button>
      <button
        @click="savePin"
        :disabled="pinDialogBusy || !pinDialogUrl.trim()"
        class="btn btn-primary btn-sm"
      >{{ pinDialogBusy ? 'Saving…' : 'Pin' }}</button>
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
