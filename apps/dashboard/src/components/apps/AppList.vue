<script setup lang="ts">
import Tip from '../ui/Tip.vue'
import { BookmarkIcon, EllipsisIcon, SquareIcon, ExternalLinkIcon, PackageIcon, PlayIcon, PlusIcon, RefreshCwIcon, ScrollTextIcon, SquarePenIcon, Trash2Icon } from '@lucide/vue'
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
import { pollJobResult, JobError } from '../../lib/jobs'
import { viewableJobId, viewLogsAction } from '../../lib/jobLogs'
import { useNotifications } from '../../lib/notifications'
import { useToast } from '../../lib/toast'
import { applyPlannedJob } from '../../lib/plan'
import { pendingAppFocus, appToFocus } from '../../lib/app-focus'
import { updateText } from '../../lib/app-update'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
    case 'running':       return 'bg-success'
    case 'stopped':       return 'bg-muted-foreground'
    case 'error':         return 'bg-primary'
    case 'transitioning': return 'bg-warning animate-pulse'
    default:              return 'bg-warning'
  }
}

function statusText(status: string) {
  switch (status) {
    case 'running':       return { label: 'Running',  cls: 'text-success' }
    case 'stopped':       return { label: 'Stopped',  cls: 'text-muted-foreground'   }
    case 'error':         return { label: 'Error',    cls: 'text-primary'   }
    case 'transitioning': return { label: 'Updating…',cls: 'text-warning'  }
    default:              return { label: 'Unknown',  cls: 'text-muted-foreground'   }
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
            <div class="w-16 h-16 rounded-xl bg-muted border border-border flex items-center justify-center">
              <PackageIcon class="w-8 h-8 text-muted-foreground" aria-hidden="true" />
            </div>
          </template>
          <template #action>
            <Button
              @click="openNew"
            >
              <PlusIcon class="w-4 h-4" aria-hidden="true" />
              New App
            </Button>
          </template>
        </EmptyState>
      </div>

      <div v-else class="flex flex-col flex-1">

        <!-- Quick access -->
        <div v-if="pinnedApps.length" class="px-6 pt-5 pb-5 border-b border-border">
          <p class="text-2xs font-semibold text-muted-foreground uppercase tracking-caps mb-3">Quick access</p>
          <TransitionGroup tag="div" name="ui-pop" class="pinned-grid relative flex flex-wrap gap-2.5">
            <a
              v-for="app in pinnedApps" :key="app.id"
              :href="app.app?.pinnedUrl ?? ''" target="_blank" rel="noopener"
              class="group flex items-center gap-3 px-3.5 py-2.5 bg-muted border border-input rounded-xl hover:bg-accent transition-all no-underline"
            >
              <span :class="['w-2 h-2 rounded-full flex-shrink-0', statusDot(app.status)]" />
              <div class="min-w-0">
                <p class="text-sm font-semibold text-foreground font-mono leading-none">{{ app.name }}</p>
                <p class="text-2xs text-muted-foreground mt-0.5 truncate max-w-[180px]">{{ app.app?.pinnedUrl }}</p>
              </div>
              <ExternalLinkIcon class="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground/80 transition-colors flex-shrink-0" aria-hidden="true" />
            </a>
          </TransitionGroup>
        </div>

        <!-- Mobile cards -->
        <div class="space-y-2 px-3 pb-3 sm:hidden">
          <article v-for="app in apps" :key="app.id" :data-app-name="app.name" :class="['rounded-xl border border-border p-3 transition-colors', focusedName === app.name ? 'bg-primary/10' : 'bg-card']">
            <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><div class="flex items-center gap-2 flex-wrap"><span :class="['h-2 w-2 shrink-0 rounded-full',statusDot(app.status)]"/><strong class="block truncate font-mono text-sm text-foreground">{{app.name}}</strong><Badge variant="outline" v-if="holdForApp(app.name)" class="bg-destructive/10 text-destructive">Blocked</Badge><span v-if="app.catalogUpdate" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-warning border-warning/40" :title="`${updateText(app.catalogUpdate)}. Update it from the App Store.`">Update</span><span v-if="app.pendingApply" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-primary border-primary/40">Changes pending</span><span v-else-if="app.drifted" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-warning border-warning/40">Modified outside HSI</span></div><p class="mt-1 truncate font-mono text-2xs text-muted-foreground" :title="app.app?.image">{{app.app?.image ?? '-'}}</p><p class="mt-1 text-xs" :class="statusText(app.status).cls">{{statusText(app.status).label}} · {{portsSummary(app)}}</p><div v-if="app.services && app.services.length > 1" class="mt-1.5 flex flex-col gap-0.5"><div v-for="svc in app.observed" :key="svc.name" class="flex items-center gap-1.5"><span :class="['w-1 h-1 rounded-full',statusDot(svc.status)]"/><span class="font-mono text-2xs text-muted-foreground">{{svc.name}}</span></div></div></div><Button variant="ghost" size="icon" class="touch-target shrink-0 text-muted-foreground" aria-label="Edit container" @click="openEdit(app)"><EllipsisIcon /></Button></div>
            <div class="mt-3 grid grid-cols-4 gap-1 border-t border-border pt-2"><Button variant="ghost" size="sm" class="touch-target text-success" :disabled="!!actionLoading[app.id]" @click="runAction(app.id,'start')">Start</Button><Button variant="ghost" size="sm" class="touch-target text-warning" :disabled="!!actionLoading[app.id]" @click="runAction(app.id,'stop')">Stop</Button><Button variant="ghost" size="sm" class="touch-target text-foreground/80" :disabled="!!actionLoading[app.id]" @click="runAction(app.id,'restart')">Restart</Button><Button variant="ghost" size="sm" class="touch-target text-foreground/80" @click="openLogs(app)">Logs</Button></div>
          </article>
        </div>

        <!-- Desktop table -->
        <div class="hidden overflow-x-auto sm:block">
        <Table class="w-full text-sm">
          <TableHeader>
            <TableRow class="border-b border-border">
              <TableHead class="text-left px-6 py-2.5 text-2xs font-semibold text-muted-foreground uppercase tracking-caps">Container</TableHead>
              <TableHead class="text-left px-3 py-2.5 text-2xs font-semibold text-muted-foreground uppercase tracking-caps hidden sm:table-cell">Image</TableHead>
              <TableHead class="text-left px-3 py-2.5 text-2xs font-semibold text-muted-foreground uppercase tracking-caps hidden md:table-cell">Ports</TableHead>
              <TableHead class="text-left px-3 py-2.5 text-2xs font-semibold text-muted-foreground uppercase tracking-caps">Status</TableHead>
              <TableHead class="px-6 py-2.5 text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody class="divide-y divide-border">
            <TableRow
              v-for="app in apps" :key="app.id"
              :data-app-name="app.name"
              :class="['group transition-colors', focusedName === app.name ? 'bg-primary/10' : 'hover:bg-accent']"
            >
              <!-- Name -->
              <TableCell class="px-6 py-3.5">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-foreground/80 text-sm font-medium">{{ app.name }}</span>
                  <Tip v-if="holdForApp(app.name)" :text="`Stopped by HSI: ${holdLabel(holdForApp(app.name)!)}`"><Badge variant="outline" class="bg-destructive/10 text-destructive">Blocked</Badge></Tip>
                  <span v-if="app.catalogUpdate" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-warning border-warning/40" :title="`${updateText(app.catalogUpdate)}. Update it from the App Store.`">Update</span>
                  <BookmarkIcon v-if="app.app?.pinnedUrl" class="w-3 h-3 text-primary flex-shrink-0" aria-hidden="true" />
                  <span v-if="app.pendingApply" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-primary border-primary/40">Changes pending</span>
                  <span v-else-if="app.drifted" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-warning border-warning/40">Modified outside HSI</span>
                </div>
                <div v-if="app.services && app.services.length > 1" class="mt-1.5 flex flex-col gap-0.5">
                  <div v-for="svc in app.observed" :key="svc.name" class="flex items-center gap-1.5">
                    <span :class="['w-1 h-1 rounded-full', statusDot(svc.status)]" />
                    <span class="font-mono text-2xs text-muted-foreground">{{ svc.name }}</span>
                  </div>
                </div>
              </TableCell>

              <!-- Image -->
              <TableCell class="px-3 py-3.5 hidden sm:table-cell">
                <span class="font-mono text-muted-foreground text-xs truncate block">{{ app.app?.image ?? '-' }}</span>
              </TableCell>

              <!-- Ports -->
              <TableCell class="px-3 py-3.5 hidden md:table-cell">
                <span class="font-mono text-muted-foreground text-xs">{{ portsSummary(app) }}</span>
              </TableCell>

              <!-- Status -->
              <TableCell class="px-3 py-3.5">
                <span class="flex items-center gap-1.5">
                  <span :class="['w-1.5 h-1.5 rounded-full', statusDot(app.status)]" />
                  <span :class="['text-xs', statusText(app.status).cls]">{{ statusText(app.status).label }}</span>
                </span>
              </TableCell>

              <!-- Actions -->
              <TableCell class="px-6 py-3.5">
                <div class="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">

                  <!-- Apply -->
                  <Button variant="outline" size="xs"
                    v-if="app.pendingApply || app.drifted"
                    @click="applyApp(app.id)"
                    :disabled="!!actionLoading[app.id]"
                    tooltip="Apply changes"
                    class="mr-1.5 text-2xs text-primary border-primary/40"
                  >
                    Apply
                  </Button>

                  <!-- Start / Stop / Restart -->
                  <ButtonGroup class="mr-1.5" aria-label="Container actions">
                    <Button variant="outline" size="icon-sm" :disabled="!!actionLoading[app.id]" tooltip="Start" aria-label="Start" class="text-muted-foreground hover:text-success" @click="runAction(app.id, 'start')">
                      <PlayIcon class="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button variant="outline" size="icon-sm" :disabled="!!actionLoading[app.id]" tooltip="Stop" aria-label="Stop" class="text-muted-foreground hover:text-warning" @click="runAction(app.id, 'stop')">
                      <SquareIcon class="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button variant="outline" size="icon-sm" :disabled="!!actionLoading[app.id]" tooltip="Restart" aria-label="Restart" class="text-muted-foreground hover:text-primary" @click="runAction(app.id, 'restart')">
                      <RefreshCwIcon class="size-3.5" aria-hidden="true" />
                    </Button>
                  </ButtonGroup>

                  <!-- Logs -->
                  <Button variant="ghost" size="icon-sm"
                    @click="openLogs(app)"
                    tooltip="Logs" aria-label="Logs"
                    class="text-muted-foreground hover:text-foreground"
                  >
                    <ScrollTextIcon class="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>

                  <!-- Pin -->
                  <Button variant="ghost" size="icon-sm"
                    @click="app.app?.pinnedUrl ? unpin(app) : openPinDialog(app)"
                    :tooltip="app.app?.pinnedUrl ? 'Unpin from quick access' : 'Pin to quick access'" :aria-label="app.app?.pinnedUrl ? 'Unpin from quick access' : 'Pin to quick access'"
                    :aria-pressed="!!app.app?.pinnedUrl"
                    :class="app.app?.pinnedUrl ? 'text-primary' : 'text-muted-foreground'"
                  >
                    <BookmarkIcon class="size-3.5" :fill="app.app?.pinnedUrl ? 'currentColor' : 'none'" aria-hidden="true" />
                  </Button>

                  <!-- Edit -->
                  <Button variant="ghost" size="icon-sm"
                    @click="openEdit(app)"
                    tooltip="Edit" aria-label="Edit"
                    class="text-muted-foreground hover:text-foreground"
                  >
                    <SquarePenIcon class="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>

                  <!-- Delete -->
                  <Button variant="ghost" size="icon-sm"
                    @click="runAction(app.id, 'delete')"
                    :disabled="!!actionLoading[app.id]"
                    tooltip="Delete" aria-label="Delete"
                    class="text-muted-foreground hover:text-primary"
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
      <h3 class="text-sm font-semibold text-foreground">
        Pin <span class="font-mono text-primary">{{ pinDialog.name }}</span> to quick access
      </h3>
    </template>

    <div class="p-5 space-y-1.5">
      <label class="text-xs text-muted-foreground">URL</label>
      <Input
        v-model="pinDialogUrl"
        placeholder="http://192.168.1.x:8080"
        @keydown.enter.prevent="savePin"
        @keydown.escape="pinDialog = null"
        autofocus
        class="w-full px-3 py-2 text-sm font-mono"
      />
      <p v-if="pinDialogErr" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ pinDialogErr }}</p>
    </div>

    <template #footer>
      <div class="flex-1" />
      <Button variant="ghost" size="sm" @click="pinDialog = null">Cancel</Button>
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
