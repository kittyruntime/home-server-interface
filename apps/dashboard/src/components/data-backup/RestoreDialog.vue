<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned, previewErrorOf } from '../../lib/plan'
import { formatDateTime } from '../../lib/format-date'
import { breadcrumbs, bytesLabel, commonPrefix, parentPath, restorePayload } from '../../lib/backup'
import Modal from '../ui/Modal.vue'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import EmptyState from '../ui/EmptyState.vue'
import BusyLabel from '../ui/BusyLabel.vue'

// Browse the snapshots of a repository, pick a file or folder in one, and restore it
// into a new folder or over its original location.
type Status = Awaited<ReturnType<typeof trpc.backup.status.query>>
type Snapshot = { id: string; shortId: string; time: string; paths: string[]; tags: string[]; consistent: boolean; plan: string }
type Entry = { name: string; path: string; type: string; size: number; mtime: string }
type Restored = NonNullable<Awaited<ReturnType<typeof trpc.backup.restoreStatus.query>>['result']>

const props = defineProps<{ repository: Status['repositories'][number]; plans: Status['plans'] }>()
const emit = defineEmits<{ close: [] }>()

const snapshots = ref<Snapshot[]>([])
const loading = ref(true)
const error = ref('')

const snapshot = ref<Snapshot | null>(null)
const root = ref('/')
const dir = ref('/')
const entries = ref<Entry[]>([])
const listing = ref(false)
const listError = ref('')
const selected = ref('')

const target = ref<'new' | 'original'>('new')
const confirmOverwrite = ref(false)
const confirmError = ref('')
const restoreError = ref('')
const starting = ref(false)

const progress = ref<number | null>(null)
const result = ref<Restored | null>(null)
const unknown = ref(false)
const running = ref(false)

const crumbs = computed(() => breadcrumbs(dir.value, root.value))
const selectedEntry = computed(() => entries.value.find(e => e.path === selected.value))

function planName(s: Snapshot): string {
  return props.plans.find(p => p.id === s.plan)?.name ?? 'Unknown plan'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    snapshots.value = (await trpc.backup.snapshots.query({ repository: props.repository.id })) as Snapshot[]
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : 'Failed to list the snapshots'
  } finally {
    loading.value = false
  }
}

// Counts folder loads, so a slow answer to an earlier click never replaces a later one.
let listSeq = 0

async function open(path: string) {
  if (!snapshot.value) return
  const seq = ++listSeq
  listing.value = true
  listError.value = ''
  try {
    const found = (await trpc.backup.ls.query({ repository: props.repository.id, snapshot: snapshot.value.id, path })) as Entry[]
    if (seq !== listSeq) return
    entries.value = found
    dir.value = path
  } catch (e) {
    if (seq !== listSeq) return
    listError.value = e instanceof Error && e.message ? e.message : 'Failed to list this folder'
  } finally {
    if (seq === listSeq) listing.value = false
  }
}

function pick(s: Snapshot) {
  snapshot.value = s
  root.value = commonPrefix(s.paths)
  selected.value = ''
  entries.value = []
  void open(root.value)
}

function back() {
  if (running.value) return
  listSeq++
  snapshot.value = null
  result.value = null
  restoreError.value = ''
  confirmError.value = ''
}

function chooseTarget(t: 'new' | 'original') {
  target.value = t
  confirmError.value = ''
}

let timer = 0
let stopped = false

// Without a progress or a result for this long after the apply, the restore is given up on.
const STATUS_GRACE_MS = 30_000

async function poll(runId: string, since: number) {
  try {
    const s = await trpc.backup.restoreStatus.query({ runId })
    if (stopped) return
    if (s.progress || s.result) since = Date.now()
    progress.value = s.progress ? s.progress.percentDone : progress.value
    if (s.result && s.result.status !== 'running') {
      result.value = s.result
      running.value = false
      return
    }
  } catch {
    // A missed poll is retried; the restore itself runs in its own unit.
  }
  if (stopped) return
  if (Date.now() - since > STATUS_GRACE_MS) {
    unknown.value = true
    running.value = false
    return
  }
  timer = window.setTimeout(() => poll(runId, since), 2_000)
}

async function restore() {
  if (!snapshot.value || !selected.value) return
  restoreError.value = ''
  confirmError.value = ''
  starting.value = true
  try {
    const reply = await applyPlanned('backup.restore', restorePayload(props.repository.id, snapshot.value.id, selected.value, target.value, confirmOverwrite.value), {
      domain: 'storage',
      title: 'Restore',
      actionLabel: 'Restore',
      danger: target.value === 'original',
    })
    if (typeof reply.runId !== 'string') throw new Error('The restore did not start')
    progress.value = 0
    unknown.value = false
    running.value = true
    void poll(reply.runId, Date.now())
  } catch (e) {
    const refused = previewErrorOf(e)
    if (/replaces \d+ files/i.test(refused)) confirmError.value = refused
    else if (refused) restoreError.value = refused
    else if (e instanceof Error && e.message) restoreError.value = e.message
  } finally {
    starting.value = false
  }
}

onMounted(load)
onUnmounted(() => {
  stopped = true
  window.clearTimeout(timer)
})
</script>

<template>
  <Modal panel-class="w-full max-w-3xl" @close="emit('close')">
    <template #header>
      <h3 class="text-sm font-semibold text-[var(--c-text-1)] truncate">Restore from {{ repository.name }}</h3>
    </template>

    <div class="px-5 py-4 space-y-4">
      <!-- Snapshots -->
      <template v-if="!snapshot">
        <LoadingState v-if="loading" variant="compact" />
        <ErrorState v-else-if="error" :message="error" retry-label="Retry" compact @retry="load" />
        <EmptyState v-else-if="!snapshots.length" message="No snapshot yet." />
        <ul v-else class="divide-y divide-[var(--c-border)] rounded-xl border border-[var(--c-border)]">
          <li v-for="s in snapshots" :key="s.id">
            <button class="block w-full min-w-0 px-3 py-2 text-left hover:bg-[var(--c-surface-deep)]" @click="pick(s)">
              <span class="flex flex-wrap items-center gap-2">
                <span class="text-sm text-[var(--c-text-1)]">{{ formatDateTime(s.time) }}</span>
                <span class="text-xs text-[var(--c-text-2)]">{{ planName(s) }}</span>
                <span v-if="!s.consistent" class="badge bg-warning/10 text-warning" title="An app could not be stopped during the run">Inconsistent</span>
              </span>
              <span class="mt-1 block break-all font-mono text-2xs text-[var(--c-text-3)]">{{ s.paths.join(', ') }}</span>
            </button>
          </li>
        </ul>
      </template>

      <!-- Tree and target -->
      <template v-else-if="!running && !result && !unknown">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-[var(--c-text-2)]">{{ formatDateTime(snapshot.time) }} · {{ planName(snapshot) }}</p>
          <button class="btn btn-ghost btn-xs" @click="back">Other snapshot</button>
        </div>

        <nav aria-label="Folder" class="flex flex-wrap items-center gap-1 text-xs">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <span v-if="i" class="text-[var(--c-text-3)]">/</span>
            <button class="break-all text-accent hover:underline" :disabled="c.path === dir" @click="open(c.path)">{{ c.name }}</button>
          </template>
        </nav>

        <ErrorState v-if="listError" :message="listError" retry-label="Retry" compact @retry="open(dir)" />
        <LoadingState v-else-if="listing && !entries.length" variant="compact" />
        <div v-else class="rounded-xl border border-[var(--c-border)]">
          <button v-if="dir !== root" class="block w-full px-3 py-2 text-left text-xs text-[var(--c-text-2)] hover:bg-[var(--c-surface-deep)]" @click="open(parentPath(dir))">..</button>
          <EmptyState v-if="!entries.length" message="This folder is empty." />
          <ul v-else class="divide-y divide-[var(--c-border)]" :class="{ 'opacity-60': listing }">
            <li v-for="e in entries" :key="e.path" class="flex min-w-0 items-center gap-2 px-3 py-2">
              <input v-model="selected" type="radio" name="restore-entry" :value="e.path" :aria-label="`Select ${e.name}`" class="accent-accent shrink-0" />
              <button v-if="e.type === 'dir'" class="min-w-0 break-all text-left text-sm text-[var(--c-text-1)] hover:underline" @click="open(e.path)">{{ e.name }}/</button>
              <span v-else class="min-w-0 break-all text-sm text-[var(--c-text-1)]">{{ e.name }}</span>
              <span v-if="e.type !== 'dir'" class="ml-auto shrink-0 text-2xs tabular-nums text-[var(--c-text-3)]">{{ bytesLabel(e.size) }}</span>
            </li>
          </ul>
        </div>

        <fieldset class="space-y-2">
          <legend class="eyebrow mb-1">Restore to</legend>
          <label class="flex items-start gap-2 text-sm text-[var(--c-text-1)]">
            <input type="radio" name="restore-target" class="mt-0.5 accent-accent" :checked="target === 'new'" @change="chooseTarget('new')" />
            <span>Into a new folder (recommended)</span>
          </label>
          <label class="flex items-start gap-2 text-sm text-[var(--c-text-1)]">
            <input type="radio" name="restore-target" class="mt-0.5 accent-accent" :checked="target === 'original'" @change="chooseTarget('original')" />
            <span>Over the original location</span>
          </label>
        </fieldset>

        <div v-if="target === 'original'" class="space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-3">
          <p class="text-xs text-warning">Files with the same name at the original location are replaced by their saved version. Nothing is deleted.</p>
          <label class="flex items-start gap-2 text-sm text-[var(--c-text-1)]">
            <input v-model="confirmOverwrite" type="checkbox" class="mt-0.5 accent-accent" />
            <span>Replace the current files</span>
          </label>
          <p v-if="confirmError" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ confirmError }}</p>
        </div>
        <p v-if="restoreError" role="alert" class="status-text text-danger break-words"><span class="status-tag">[ERR]</span> {{ restoreError }}</p>

        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost btn-sm" @click="emit('close')">Close</button>
          <button class="btn btn-primary btn-sm" :disabled="!selected || starting || (target === 'original' && !confirmOverwrite)" @click="restore">
            <BusyLabel :busy="starting" busy-label="Preparing">{{ selectedEntry ? `Restore ${selectedEntry.name}…` : 'Restore…' }}</BusyLabel>
          </button>
        </div>
      </template>

      <!-- Progress -->
      <template v-else-if="running">
        <p class="text-sm text-[var(--c-text-1)]">Restoring{{ progress !== null ? `, ${Math.round(progress * 100)}%` : '' }}</p>
        <div class="h-2 overflow-hidden rounded-full bg-[var(--c-surface-deep)]" role="progressbar" :aria-valuenow="Math.round((progress ?? 0) * 100)" aria-valuemin="0" aria-valuemax="100">
          <div class="h-full bg-accent transition-all" :style="{ width: `${Math.round((progress ?? 0) * 100)}%` }"></div>
        </div>
      </template>

      <p v-else-if="unknown" role="alert" class="status-text text-warning"><span class="status-tag">[WARN]</span> The status of this restore is unknown. Look for it in the History of this repository.</p>

      <!-- Result -->
      <template v-else-if="result">
        <p v-if="result.status === 'failed'" role="alert" class="status-text text-danger break-words"><span class="status-tag">[ERR]</span> {{ result.error || 'The restore failed' }}</p>
        <p v-else class="text-sm text-success">{{ result.files ?? 0 }} files restored</p>
        <p v-if="result.status === 'success' && result.target" class="break-all text-xs text-[var(--c-text-2)]">Restored to <span class="font-mono">{{ result.target }}</span></p>
        <div v-if="result.warnings?.length">
          <p class="eyebrow mb-1">Not restored as saved on this destination</p>
          <p v-for="w in result.warnings" :key="w" class="status-text text-warning break-words"><span class="status-tag">[WARN]</span> {{ w }}</p>
        </div>
        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost btn-sm" @click="result = null; confirmOverwrite = false">Restore another</button>
          <button class="btn btn-primary btn-sm" @click="emit('close')">Close</button>
        </div>
      </template>
    </div>
  </Modal>
</template>
