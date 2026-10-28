<script setup lang="ts">
import Tip from '../ui/Tip.vue'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned, previewCodeOf, previewErrorOf } from '../../lib/plan'
import { formatDateTime } from '../../lib/format-date'
import { asksOverwriteConfirm, breadcrumbs, bytesLabel, commonPrefix, latestOnly, parentPath, restorePayload, restorePollStep } from '../../lib/backup'
import Modal from '../ui/Modal.vue'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import EmptyState from '../ui/EmptyState.vue'
import BusyLabel from '../ui/BusyLabel.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item } from '@/components/ui/item'

// Browse the snapshots of a repository, pick a file or folder in one, and restore it
// into a new folder or over its original location.
type Status = Awaited<ReturnType<typeof trpc.backup.status.query>>
type Snapshot = Awaited<ReturnType<typeof trpc.backup.snapshots.query>>[number]
type Entry = Awaited<ReturnType<typeof trpc.backup.ls.query>>[number]
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
    snapshots.value = await trpc.backup.snapshots.query({ repository: props.repository.id })
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : 'Failed to list the snapshots'
  } finally {
    loading.value = false
  }
}

// Folder loads: a slow answer to an earlier click never replaces a later one.
const folderLoads = latestOnly()

async function open(path: string) {
  if (!snapshot.value) return
  const current = folderLoads.next()
  listing.value = true
  listError.value = ''
  try {
    const found = await trpc.backup.ls.query({ repository: props.repository.id, snapshot: snapshot.value.id, path })
    if (!current()) return
    entries.value = found
    dir.value = path
  } catch (e) {
    if (!current()) return
    listError.value = e instanceof Error && e.message ? e.message : 'Failed to list this folder'
  } finally {
    if (current()) listing.value = false
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
  folderLoads.next()
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

async function poll(runId: string, since: number) {
  let s: Awaited<ReturnType<typeof trpc.backup.restoreStatus.query>> | null = null
  try {
    s = await trpc.backup.restoreStatus.query({ runId })
  } catch {
    // A missed poll is retried; the restore itself runs in its own unit.
  }
  if (stopped) return
  if (s?.progress) progress.value = s.progress.percentDone
  const step = restorePollStep(s, since, Date.now())
  if (step.state === 'done') {
    result.value = step.result
    running.value = false
    return
  }
  if (step.state === 'gone') {
    unknown.value = true
    running.value = false
    return
  }
  timer = window.setTimeout(() => poll(runId, step.since), 2_000)
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
    if (asksOverwriteConfirm(previewCodeOf(e))) confirmError.value = refused
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
      <h3 class="text-sm font-semibold text-foreground truncate">Restore from {{ repository.name }}</h3>
    </template>

    <div class="px-5 py-4 space-y-4">
      <!-- Snapshots -->
      <template v-if="!snapshot">
        <LoadingState v-if="loading" variant="compact" />
        <ErrorState v-else-if="error" :message="error" retry-label="Retry" compact @retry="load" />
        <EmptyState v-else-if="!snapshots.length" message="No snapshot yet." />
        <ul v-else class="divide-y divide-border rounded-xl border border-border">
          <li v-for="s in snapshots" :key="s.id">
            <Item as="button" size="sm" class="block w-full min-w-0 rounded-none px-3 py-2 text-left hover:bg-muted" @click="pick(s)">
              <span class="flex flex-wrap items-center gap-2">
                <span class="text-sm text-foreground">{{ formatDateTime(s.time) }}</span>
                <span class="text-xs text-foreground/80">{{ planName(s) }}</span>
                <Tip v-if="!s.consistent" text="An app could not be stopped during the run"><Badge variant="outline" class="bg-warning/10 text-warning">Inconsistent</Badge></Tip>
              </span>
              <span class="mt-1 block break-all font-mono text-2xs text-muted-foreground">{{ s.paths.join(', ') }}</span>
            </Item>
          </li>
        </ul>
      </template>

      <!-- Tree and target -->
      <template v-else-if="!running && !result && !unknown">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-foreground/80">{{ formatDateTime(snapshot.time) }} · {{ planName(snapshot) }}</p>
          <Button variant="ghost" size="xs" @click="back">Other snapshot</Button>
        </div>

        <nav aria-label="Folder" class="flex flex-wrap items-center gap-1 text-xs">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <span v-if="i" class="text-muted-foreground">/</span>
            <Button variant="link" class="h-auto p-0 break-all text-primary" :disabled="c.path === dir" @click="open(c.path)">{{ c.name }}</Button>
          </template>
        </nav>

        <ErrorState v-if="listError" :message="listError" retry-label="Retry" compact @retry="open(dir)" />
        <LoadingState v-else-if="listing && !entries.length" variant="compact" />
        <div v-else class="rounded-xl border border-border">
          <Button v-if="dir !== root" variant="ghost" size="sm" class="w-full justify-start rounded-none rounded-t-xl px-3 text-xs font-normal text-foreground/80" @click="open(parentPath(dir))">..</Button>
          <EmptyState v-if="!entries.length" message="This folder is empty." />
          <RadioGroup v-else v-model="selected" as="ul" class="gap-0 divide-y divide-border" :class="{ 'opacity-60': listing }">
            <li v-for="e in entries" :key="e.path" class="flex min-w-0 items-center gap-2 px-3 py-2">
              <RadioGroupItem :value="e.path" :aria-label="`Select ${e.name}`" class="shrink-0" />
              <Button variant="link" v-if="e.type === 'dir'" class="h-auto p-0 min-w-0 break-all text-left text-foreground" @click="open(e.path)">{{ e.name }}/</Button>
              <span v-else class="min-w-0 break-all text-sm text-foreground">{{ e.name }}</span>
              <span v-if="e.type !== 'dir'" class="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground">{{ bytesLabel(e.size) }}</span>
            </li>
          </RadioGroup>
        </div>

        <fieldset class="space-y-2">
          <legend class="eyebrow mb-1">Restore to</legend>
          <RadioGroup :model-value="target" class="gap-2" @update:model-value="value => chooseTarget(value === 'original' ? 'original' : 'new')">
            <label class="flex items-start gap-2 text-sm text-foreground">
              <RadioGroupItem value="new" class="mt-0.5" />
              <span>Into a new folder (recommended)</span>
            </label>
            <label class="flex items-start gap-2 text-sm text-foreground">
              <RadioGroupItem value="original" class="mt-0.5" />
              <span>Over the original location</span>
            </label>
          </RadioGroup>
        </fieldset>

        <div v-if="target === 'original'" class="space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-3">
          <p class="text-xs text-warning">Files with the same name at the original location are replaced by their saved version. Nothing is deleted.</p>
          <label class="flex items-start gap-2 text-sm text-foreground">
            <Checkbox v-model="confirmOverwrite" class="mt-0.5" />
            <span>Replace the current files</span>
          </label>
          <p v-if="confirmError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ confirmError }}</p>
        </div>
        <p v-if="restoreError" role="alert" class="status-text text-destructive break-words"><span class="status-tag">[ERR]</span> {{ restoreError }}</p>

        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="emit('close')">Close</Button>
          <Button size="sm" :disabled="!selected || starting || (target === 'original' && !confirmOverwrite)" @click="restore">
            <BusyLabel :busy="starting" busy-label="Preparing">{{ selectedEntry ? `Restore ${selectedEntry.name}…` : 'Restore…' }}</BusyLabel>
          </Button>
        </div>
      </template>

      <!-- Progress -->
      <template v-else-if="running">
        <p class="text-sm text-foreground">Restoring{{ progress !== null ? `, ${Math.round(progress * 100)}%` : '' }}</p>
        <div class="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" :aria-valuenow="Math.round((progress ?? 0) * 100)" aria-valuemin="0" aria-valuemax="100">
          <div class="h-full bg-primary transition-all" :style="{ width: `${Math.round((progress ?? 0) * 100)}%` }"></div>
        </div>
      </template>

      <p v-else-if="unknown" role="alert" class="status-text text-warning"><span class="status-tag">[WARN]</span> The status of this restore is unknown. Look for it in the History of this repository.</p>

      <!-- Result -->
      <template v-else-if="result">
        <p v-if="result.status === 'failed'" role="alert" class="status-text text-destructive break-words"><span class="status-tag">[ERR]</span> {{ result.error || 'The restore failed' }}</p>
        <p v-else class="text-sm text-success">{{ result.files ?? 0 }} files restored</p>
        <p v-if="result.status === 'success' && result.target" class="break-all text-xs text-foreground/80">Restored to <span class="font-mono">{{ result.target }}</span></p>
        <div v-if="result.warnings?.length">
          <p class="eyebrow mb-1">Not restored as saved on this destination</p>
          <p v-for="w in result.warnings" :key="w" class="status-text text-warning break-words"><span class="status-tag">[WARN]</span> {{ w }}</p>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="result = null; confirmOverwrite = false">Restore another</Button>
          <Button size="sm" @click="emit('close')">Close</Button>
        </div>
      </template>
    </div>
  </Modal>
</template>
