<script setup lang="ts">
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, CopyIcon, PauseIcon, PlayIcon, SquareIcon, UploadIcon, XIcon } from '@lucide/vue'
import { LOADING } from '../../lib/loading'
import { ref, computed } from 'vue'
import { useUploads, type Transfer, type TransferStatus } from '../../lib/uploads'
import { resumeByReselect } from '../../lib/upload-runner'
import LoadingSpinner from '../ui/LoadingSpinner.vue'



const uploads = useUploads()
const collapsed = ref(false)

// Hidden input used to re-select a file for an `interrupted` (post-reload)
// transfer: the browser has no way to reconnect to the original File handle
// across a reload, so resuming requires the user to pick the file again.
const reselectInput = ref<HTMLInputElement | null>(null)
const reselectTargetId = ref<string | null>(null)

// Non-terminal: still doing (or about to do) something.
const ACTIVE: TransferStatus[] = ['uploading', 'verifying', 'running', 'paused', 'queued']
// Done, one way or another, safe to dismiss.
const TERMINAL: TransferStatus[] = ['done', 'cancelled', 'error']
// Pause/resume + cancel both make sense on these.
const PAUSABLE: TransferStatus[] = ['uploading', 'running', 'paused']

const activeCount = computed(() => uploads.tasks.value.filter(t => ACTIVE.includes(t.status)).length)
const hasTerminal = computed(() => uploads.tasks.value.some(t => TERMINAL.includes(t.status)))

// Newest first: a fresh array, never touches the reactive `tasks` in place.
const reversedTasks = computed(() => [...uploads.tasks.value].reverse())

// Overall mini bar: byte-weighted average across active transfers that report
// a total size (uploads). null → nothing determinate to show (e.g. only
// copy/move jobs running), which renders as an indeterminate pulse instead.
const overallPct = computed<number | null>(() => {
  const withSize = uploads.tasks.value.filter(
    t => ACTIVE.includes(t.status) && typeof t.totalBytes === 'number' && t.totalBytes > 0
  )
  if (!withSize.length) return null
  const total = withSize.reduce((s, t) => s + (t.totalBytes ?? 0), 0)
  const sent  = withSize.reduce((s, t) => s + (t.sentBytes ?? 0), 0)
  return total > 0 ? Math.round((sent / total) * 100) : 0
})

function pct(t: Transfer): number {
  if (t.totalBytes) return Math.round(((t.sentBytes ?? 0) / t.totalBytes) * 100)
  if (t.totalChunks) return Math.round(((t.sentChunks ?? 0) / t.totalChunks) * 100)
  return 0
}

function speed(bps: number): string {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`
  if (bps >= 1_024)     return `${(bps / 1_024).toFixed(0)} KB/s`
  return bps > 0 ? `${Math.round(bps)} B/s` : ''
}

function statusLabel(t: Transfer): string {
  switch (t.status) {
    case 'uploading':  return pct(t) + '%'
    case 'running':    return 'running'
    case 'paused':     return 'paused'
    case 'queued':     return 'queued'
    case 'error':      return 'error'
    case 'done':       return 'done'
    case 'cancelled':  return 'cancelled'
    case 'verifying':  return ''
    default:           return t.status
  }
}

function statusTextClass(t: Transfer): string {
  switch (t.status) {
    case 'done':      return 'text-success'
    case 'error':     return 'text-destructive'
    case 'cancelled': return 'text-muted-foreground'
    case 'paused':    return 'text-warning'
    default:          return 'text-muted-foreground'
  }
}

function iconClass(t: Transfer): string {
  switch (t.status) {
    case 'done':      return 'bg-success/10 text-success'
    case 'error':     return 'bg-destructive/10 text-destructive'
    case 'cancelled': return 'bg-muted text-muted-foreground'
    case 'paused':    return 'bg-warning/10 text-warning'
    default:          return 'bg-primary/10 text-primary'
  }
}

function canPauseResume(t: Transfer) { return PAUSABLE.includes(t.status) }
function canCancel(t: Transfer)      { return PAUSABLE.includes(t.status) }
function canRetry(t: Transfer)       { return t.status === 'error' || t.interrupted === true }
function canRemove(t: Transfer)      { return TERMINAL.includes(t.status) }

function togglePause(t: Transfer) {
  if (t.status === 'paused') uploads.resume(t.id)
  else uploads.pause(t.id)
}

function clearFinished() {
  for (const t of uploads.tasks.value.filter(t => TERMINAL.includes(t.status))) {
    uploads.remove(t.id)
  }
}

// `interrupted` (post-reload, no in-memory File) needs a re-select before it
// can resume at all: open the hidden picker instead of the in-session retry
// path. A normal `error` transfer still has its File, so the existing
// `uploads.retry()` → registerRetryHandler('upload') path just re-sends it.
function retryOrReselect(t: Transfer) {
  if (t.interrupted) {
    reselectTargetId.value = t.id
    reselectInput.value?.click()
  } else {
    uploads.retry(t.id)
  }
}

// Validation (same name + exact byte size) and the mismatch toast both live
// in `resumeByReselect`; the tray just wires the picked File through to it.
function handleReselectPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  const id = reselectTargetId.value
  reselectTargetId.value = null
  input.value = ''
  if (!file || !id) return
  resumeByReselect(id, file)
}
</script>

<template>
  <div
    v-if="uploads.tasks.value.length > 0"
    class="shrink-0 border-t border-border bg-muted"
  >
    <!-- Header -->
    <div class="flex items-center gap-3 px-3.5 py-2">
      <Button variant="ghost" size="xs" :aria-expanded="!collapsed" class="-ml-2 shrink-0 text-foreground/80" @click="collapsed = !collapsed">
        <ChevronDownIcon class="size-3 transition-transform" :class="collapsed ? '-rotate-90' : ''" aria-hidden="true" />
        {{ $t('uip.files.TransfersTray.transfersActive', { p0: activeCount }) }}
      </Button>

      <!-- Mini overall progress bar -->
      <div v-if="activeCount > 0" class="flex-1 h-1 bg-muted rounded-full overflow-hidden">
        <div v-if="overallPct !== null" class="h-full bg-primary rounded-full transition-all" :style="{ width: overallPct + '%' }" />
        <div v-else class="h-full w-1/3 bg-primary rounded-full animate-[tray-slide_1.2s_ease-in-out_infinite]" />
      </div>
      <div v-else class="flex-1" />

      <Button variant="link"
        v-if="hasTerminal"
        @click="clearFinished"
        class="h-auto p-0 text-2xs text-muted-foreground hover:text-foreground/80 uppercase tracking-caps shrink-0"
      >
        {{ $t('ui.files.TransfersTray.clearCompleted') }}
      </Button>
    </div>

    <!-- Body -->
    <div v-if="!collapsed" class="max-h-56 overflow-y-auto border-t border-border divide-y divide-border">
      <div v-for="t in reversedTasks" :key="t.id" class="px-3.5 py-2.5">
        <div class="flex items-center gap-2.5 min-w-0">
          <!-- Icon -->
          <div class="shrink-0 w-6 h-6 rounded-md flex items-center justify-center" :class="iconClass(t)">
            <CheckIcon v-if="t.status === 'done'" class="w-3.5 h-3.5" aria-hidden="true" />
            <XIcon v-else-if="t.status === 'error'" class="w-3.5 h-3.5" aria-hidden="true" />
            <CopyIcon v-else-if="t.kind === 'copy'" class="w-3.5 h-3.5" aria-hidden="true" />
            <ArrowRightIcon v-else-if="t.kind === 'move'" class="w-3.5 h-3.5" aria-hidden="true" />
            <UploadIcon v-else class="w-3.5 h-3.5" aria-hidden="true" />
          </div>

          <!-- Name + status + progress -->
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-xs text-foreground truncate" :title="t.name">{{ t.name }}</span>
              <span class="text-2xs tabular-nums shrink-0" :class="statusTextClass(t)">{{ statusLabel(t) }}</span>
            </div>

            <!-- Determinate bar (uploads: sentBytes/totalBytes) -->
            <Progress v-if="t.kind === 'upload' && (t.status === 'uploading' || t.status === 'paused')"
              class="mt-1.5 h-1 bg-muted rounded-full" :model-value="pct(t)" :indicator-class="['rounded-full transition-all', t.status === 'paused' ? 'bg-warning' : 'bg-primary']" />

            <!-- Verifying (server-side checksum before atomic rename) -->
            <div v-else-if="t.status === 'verifying'" class="mt-1">
              <LoadingSpinner :label="LOADING.verifying" />
            </div>

            <!-- Indeterminate bar (copy/move in progress) -->
            <div v-else-if="t.kind !== 'upload' && t.status === 'running'"
              class="mt-1.5 h-1 bg-muted rounded-full overflow-hidden">
              <div class="h-full w-1/3 bg-primary rounded-full animate-[tray-slide_1.2s_ease-in-out_infinite]" />
            </div>

            <!-- Speed (uploads only) -->
            <div v-if="t.kind === 'upload' && t.status === 'uploading' && (t.bytesPerSec ?? 0) > 0"
              class="text-2xs text-muted-foreground mt-0.5 tabular-nums">
              {{ speed(t.bytesPerSec ?? 0) }}
            </div>

            <!-- Full error, never truncated -->
            <div v-if="t.status === 'error' && t.error" class="text-2xs text-destructive mt-1 whitespace-pre-wrap break-words">
              {{ t.error }}
            </div>
          </div>

          <!-- Actions -->
          <div class="flex gap-0.5 shrink-0">
            <Button variant="ghost" size="icon-xs" v-if="canPauseResume(t)" @click="togglePause(t)" :tooltip="t.status === 'paused' ? 'Resume' : 'Pause'"
              :aria-label="t.status === 'paused' ? 'Resume' : 'Pause'" class="text-muted-foreground">
              <PlayIcon v-if="t.status === 'paused'" class="size-3" aria-hidden="true" />
              <PauseIcon v-else class="size-3" fill="currentColor" aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon-xs" v-if="canCancel(t)" @click="uploads.cancel(t.id)" :tooltip="$t('ui.files.TransfersTray.cancel')" :aria-label="$t('ui.files.TransfersTray.cancel')"
              class="text-muted-foreground hover:text-destructive hover:bg-destructive/10">
              <SquareIcon class="size-3" fill="currentColor" aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="xs" v-if="canRetry(t)" @click="retryOrReselect(t)" class="h-5 px-1.5 text-2xs text-primary hover:text-primary hover:bg-primary/10">
              {{ t.interrupted ? 'Resume' : 'Retry' }}
            </Button>
            <Button variant="ghost" size="icon-xs" v-if="canRemove(t)" @click="uploads.remove(t.id)" :tooltip="$t('ui.files.TransfersTray.remove')" :aria-label="$t('ui.files.TransfersTray.remove')"
              class="text-muted-foreground hover:text-foreground">
              <XIcon class="w-3 h-3" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Hidden re-select input for `interrupted` (post-reload) transfers:
         `retryOrReselect` opens this, `handleReselectPick` hands the file to
         `resumeByReselect`, which validates it's the same file before resuming. -->
    <input ref="reselectInput" type="file" class="hidden" @change="handleReselectPick" />
  </div>
</template>

<!-- Non-scoped: the keyframe name must stay un-mangled so the Tailwind arbitrary
     class `animate-[tray-slide_…]` (emitted globally) can resolve it. -->
<style>
@keyframes tray-slide {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
</style>
