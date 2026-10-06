<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { trpc } from '../lib/trpc'
import { useConfirm } from '../lib/confirm'
import { formatDateTime } from '../lib/format-date'
import { LOADING } from '../lib/loading'
import BusyLabel from './ui/BusyLabel.vue'
import LoadingSpinner from './ui/LoadingSpinner.vue'
import LoadingState from './ui/LoadingState.vue'
import EmptyState from './ui/EmptyState.vue'

// Scheduled rsync backups of NAS folders, to a local folder or an SSH host,
// or pulled from a remote target onto the NAS.

type Plan = {
  id: string
  name: string
  direction: 'push' | 'pull'
  source: string
  destination: string
  remoteHost: string | null
  remoteUser: string | null
  remotePort: number
  sshKeyPath: string | null
  schedule: 'manual' | 'hourly' | 'daily' | 'weekly'
  scheduleHour: number
  scheduleMinute: number
  scheduleWeekday: number
  deleteExtra: boolean
  compress: boolean
  bandwidthLimit: number | null
  excludes: string[]
  enabled: boolean
  lastStatus: string | null
  lastRunAt: string | null
  lastError: string | null
  nextRunAt: string | null
}
type PlanForm = Omit<Plan, 'id' | 'lastStatus' | 'lastRunAt' | 'lastError' | 'nextRunAt'>

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SCHEDULE_LABEL: Record<Plan['schedule'], string> = { manual: 'Manual', hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly' }
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', running: 'Running', completed: 'Completed', failed: 'Failed' }

const empty = (): PlanForm => ({
  name: '', direction: 'push', source: '', destination: '',
  remoteHost: null, remoteUser: null, remotePort: 22, sshKeyPath: null,
  schedule: 'manual', scheduleHour: 2, scheduleMinute: 0, scheduleWeekday: 0,
  deleteExtra: false, compress: true, bandwidthLimit: null, excludes: [], enabled: true,
})

const plans = ref<Plan[]>([])
const loading = ref(true)
const saving = ref(false)
const adding = ref(false)
const editingId = ref<string | null>(null)
const error = ref('')
const remote = ref(false)
const excludeText = ref('')
const form = ref(empty())
const { confirm } = useConfirm()

const isRunning = (p: Plan) => ['pending', 'running'].includes(p.lastStatus ?? '')
const hasRunning = computed(() => plans.value.some(isRunning))
const statusLabel = (s: string | null) => (s ? STATUS_LABEL[s] ?? s : 'Never run')
const statusClass = (s: string) => s === 'completed' ? 'bg-success/10 text-success' : s === 'failed' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
const endpoint = (p: Plan, side: 'source' | 'destination') => {
  const remoteSide = p.direction === 'pull' ? 'source' : 'destination'
  return (p.remoteHost && side === remoteSide ? `${p.remoteUser}@${p.remoteHost}:` : '') + p[side]
}

async function load() {
  plans.value = await trpc.backup.list.query() as Plan[]
}

function formOf(p: Plan): PlanForm {
  const { id: _id, lastStatus: _s, lastRunAt: _r, lastError: _e, nextRunAt: _n, ...rest } = p
  return { ...rest, excludes: [...p.excludes] }
}

function payload() {
  return {
    ...form.value,
    remoteHost: remote.value ? form.value.remoteHost : null,
    remoteUser: remote.value ? form.value.remoteUser : null,
    sshKeyPath: remote.value ? form.value.sshKeyPath : null,
    excludes: excludeText.value.split('\n').map(x => x.trim()).filter(Boolean),
  }
}

function fillForm(f: PlanForm) {
  form.value = f
  excludeText.value = f.excludes.join('\n')
  remote.value = Boolean(f.remoteHost)
}

function cancelEdit() {
  fillForm(empty())
  adding.value = false
  editingId.value = null
}

function edit(p: Plan) {
  fillForm(formOf(p))
  editingId.value = p.id
  adding.value = true
}

function errorText(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback
}

async function save() {
  error.value = ''
  saving.value = true
  try {
    if (editingId.value) await trpc.backup.update.mutate({ id: editingId.value, ...payload() })
    else await trpc.backup.create.mutate(payload())
    cancelEdit()
    await load()
  } catch (e) {
    error.value = errorText(e, 'Failed to save the backup plan')
  } finally {
    saving.value = false
  }
}

async function toggle(p: Plan) {
  error.value = ''
  const f = formOf(p)
  try {
    await trpc.backup.update.mutate({ id: p.id, ...f, enabled: !p.enabled })
    await load()
  } catch (e) {
    error.value = errorText(e, p.enabled ? 'Failed to pause the backup plan' : 'Failed to enable the backup plan')
  }
}

async function run(id: string) {
  error.value = ''
  try {
    await trpc.backup.run.mutate({ id })
    await load()
  } catch (e) {
    error.value = errorText(e, 'Failed to start the backup')
  }
}

async function remove(id: string) {
  if (!await confirm('Delete this backup plan? Existing backup files will not be removed.', { danger: true, confirmLabel: 'Delete' })) return
  error.value = ''
  try {
    await trpc.backup.delete.mutate({ id })
    await load()
  } catch (e) {
    error.value = errorText(e, 'Failed to delete the backup plan')
  }
}

let poll: number | undefined
onMounted(async () => {
  try { await load() } finally { loading.value = false }
  poll = window.setInterval(() => { if (hasRunning.value) void load() }, 3000)
})
onUnmounted(() => { if (poll) clearInterval(poll) })
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-4">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Data backups</h2>
        <p class="mt-1 max-w-lg text-xs leading-relaxed text-[var(--c-text-3)]">
          Copy NAS data to another folder or SSH host, or pull a remote target onto this NAS. Transfers use rsync and SSH keys; passwords are never stored.
        </p>
      </div>
      <button v-if="!adding" class="btn btn-primary btn-xs" @click="adding = true">New plan…</button>
    </div>

    <div v-if="error" role="alert" class="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{{ error }}</div>

    <form v-if="adding" class="space-y-4 rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-surface)] p-4" @submit.prevent="save">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-[var(--c-text-1)]">{{ editingId ? 'Edit backup plan' : 'New backup plan' }}</h3>
        <span class="badge badge-muted">rsync</span>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <label class="text-xs text-[var(--c-text-2)]">Plan name
          <input v-model="form.name" required maxlength="80" class="ui-input mt-1" placeholder="Nightly media backup">
        </label>
        <label class="text-xs text-[var(--c-text-2)]">Transfer direction
          <select v-model="form.direction" class="ui-input mt-1">
            <option value="push">NAS → destination</option>
            <option value="pull">Target → NAS</option>
          </select>
        </label>
      </div>

      <label class="flex items-center gap-2 text-xs text-[var(--c-text-2)]"><input v-model="remote" type="checkbox"> Use a remote SSH target</label>

      <div class="grid gap-3 sm:grid-cols-2">
        <label class="text-xs text-[var(--c-text-2)]">{{ form.direction === 'push' ? 'NAS source' : 'Target source' }}
          <input v-model="form.source" required class="ui-input mt-1 font-mono" placeholder="/mnt/data">
        </label>
        <label class="text-xs text-[var(--c-text-2)]">{{ form.direction === 'push' ? 'Destination' : 'NAS destination' }}
          <input v-model="form.destination" required class="ui-input mt-1 font-mono" placeholder="/mnt/backup">
        </label>
      </div>

      <div v-if="remote" class="grid gap-3 sm:grid-cols-2">
        <label class="text-xs text-[var(--c-text-2)]">Host
          <input v-model="form.remoteHost" required class="ui-input mt-1" placeholder="backup.example.net">
        </label>
        <label class="text-xs text-[var(--c-text-2)]">SSH user
          <input v-model="form.remoteUser" required class="ui-input mt-1" placeholder="backup">
        </label>
        <label class="text-xs text-[var(--c-text-2)]">SSH key path
          <input v-model="form.sshKeyPath" required class="ui-input mt-1 font-mono" placeholder="/root/.ssh/hsi_backup">
        </label>
        <label class="text-xs text-[var(--c-text-2)]">Port
          <input v-model.number="form.remotePort" type="number" min="1" max="65535" class="ui-input mt-1">
        </label>
        <p class="sm:col-span-2 text-2xs text-[var(--c-text-3)]">The host must already exist in root's known_hosts and the private key must be mode 0600 or stricter.</p>
      </div>

      <div class="grid gap-3 sm:grid-cols-3">
        <label class="text-xs text-[var(--c-text-2)]">Schedule
          <select v-model="form.schedule" class="ui-input mt-1">
            <option value="manual">Manual only</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        <label v-if="form.schedule !== 'manual'" class="text-xs text-[var(--c-text-2)]">Minute
          <input v-model.number="form.scheduleMinute" type="number" min="0" max="59" class="ui-input mt-1">
        </label>
        <label v-if="['daily', 'weekly'].includes(form.schedule)" class="text-xs text-[var(--c-text-2)]">Hour
          <input v-model.number="form.scheduleHour" type="number" min="0" max="23" class="ui-input mt-1">
        </label>
        <label v-if="form.schedule === 'weekly'" class="text-xs text-[var(--c-text-2)]">Day
          <select v-model.number="form.scheduleWeekday" class="ui-input mt-1">
            <option v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</option>
          </select>
        </label>
      </div>

      <label class="block text-xs text-[var(--c-text-2)]">Exclusions, one pattern per line
        <textarea v-model="excludeText" rows="3" class="ui-input mt-1 font-mono" placeholder=".cache/&#10;*.tmp"></textarea>
      </label>

      <div class="flex flex-wrap gap-4 text-xs text-[var(--c-text-2)]">
        <label class="flex items-center gap-2"><input v-model="form.compress" type="checkbox"> Compress transfer</label>
        <label class="flex items-center gap-2"><input v-model="form.deleteExtra" type="checkbox"> Mirror deletions at destination</label>
      </div>
      <p v-if="form.deleteExtra" class="status-text text-warning">
        <span class="status-tag">[WARN]</span> Mirror mode deletes destination files that no longer exist at the source. Verify both paths before enabling it.
      </p>

      <div class="flex gap-2">
        <button class="btn btn-primary btn-sm" :disabled="saving">
          <BusyLabel :busy="saving" :busy-label="LOADING.saving">{{ editingId ? 'Update plan' : 'Save plan' }}</BusyLabel>
        </button>
        <button type="button" class="btn btn-ghost btn-sm" @click="cancelEdit">Cancel</button>
      </div>
    </form>

    <LoadingState v-if="loading" variant="compact" />
    <div v-else-if="!plans.length && !adding" class="rounded-xl border border-dashed border-[var(--c-border-strong)]">
      <EmptyState message="No data backup plan yet." description="Create a plan to protect NAS or remote data with rsync.">
        <template #action><button class="btn btn-primary btn-sm" @click="adding = true">Create first plan…</button></template>
      </EmptyState>
    </div>

    <article v-for="p in plans" :key="p.id" class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] p-4">
      <div class="flex min-w-0 flex-col items-start justify-between gap-3 sm:flex-row">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-medium text-[var(--c-text-1)]">{{ p.name }}</h3>
            <span class="badge badge-muted">{{ SCHEDULE_LABEL[p.schedule] }}</span>
            <span :class="['badge', p.enabled ? 'bg-success/10 text-success' : 'badge-muted']">{{ p.enabled ? 'Enabled' : 'Paused' }}</span>
            <span v-if="p.lastStatus" :class="['badge', statusClass(p.lastStatus)]">{{ statusLabel(p.lastStatus) }}</span>
          </div>
          <p class="mt-1 break-all font-mono text-2xs text-[var(--c-text-3)]">{{ endpoint(p, 'source') }} → {{ endpoint(p, 'destination') }}</p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-1">
          <button class="btn btn-primary btn-xs" :disabled="isRunning(p)" @click="run(p.id)">
            <LoadingSpinner v-if="isRunning(p)" />{{ isRunning(p) ? 'Running' : 'Run now' }}
          </button>
          <button class="btn btn-ghost btn-xs" @click="edit(p)">Edit</button>
          <button class="btn btn-ghost btn-xs" @click="toggle(p)">{{ p.enabled ? 'Pause' : 'Enable' }}</button>
          <button class="btn btn-ghost btn-xs text-danger" @click="remove(p.id)">Delete…</button>
        </div>
      </div>
      <div class="mt-3 grid gap-2 text-2xs text-[var(--c-text-3)] sm:grid-cols-3">
        <span>Status: <b class="text-[var(--c-text-2)]">{{ statusLabel(p.lastStatus) }}</b></span>
        <span>Last run: {{ formatDateTime(p.lastRunAt) }}</span>
        <span>Next run: {{ p.enabled ? formatDateTime(p.nextRunAt) : 'Paused' }}</span>
      </div>
      <p v-if="p.lastError" role="alert" class="mt-2 status-text text-danger"><span class="status-tag">[ERR]</span> {{ p.lastError }}</p>
    </article>
  </section>
</template>
