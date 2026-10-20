<script setup lang="ts">
import { computed, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { runLabel, scheduleLabel, untilLabel, TONE_CLASS, type Schedule } from '../../lib/backup'
import BusyLabel from '../ui/BusyLabel.vue'
import RunHistory from './RunHistory.vue'

type Status = Awaited<ReturnType<typeof trpc.backup.status.query>>
type Plan = Status['plans'][number]

const props = defineProps<{ plan: Plan; repositories: Status['repositories'] }>()
const emit = defineEmits<{ edit: []; changed: [] }>()

const error = ref('')
const starting = ref(false)
const history = ref(false)

const running = computed(() => !!props.plan.progress || props.plan.last?.status === 'running')
const percent = computed(() => Math.round((props.plan.progress?.percentDone ?? 0) * 100))
const last = computed(() => runLabel(props.plan.last))

// Where the data goes: "source → destination", the remote side as user@host:path.
const route = computed(() => {
  const p = props.plan
  if (p.type === 'versions' && p.versions) {
    const repo = props.repositories.find(r => r.id === p.versions!.repository)
    return `${p.versions.sources.join(', ')} → ${repo?.name ?? 'missing repository'}`
  }
  const s = (p.sync ?? {}) as { direction?: string; source?: string; destination?: string; remoteHost?: string; remoteUser?: string }
  const remote = s.remoteHost ? `${s.remoteUser}@${s.remoteHost}:` : ''
  return s.direction === 'pull'
    ? `${remote}${s.source ?? ''} → ${s.destination ?? ''}`
    : `${s.source ?? ''} → ${remote}${s.destination ?? ''}`
})

async function runNow() {
  error.value = ''
  starting.value = true
  try {
    await trpc.backup.runNow.mutate({ id: props.plan.id })
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : 'Failed to start the backup'
  } finally {
    starting.value = false
  }
}

async function remove() {
  error.value = ''
  try {
    await applyPlanned('backup.plan.remove', { id: props.plan.id }, {
      title: `Remove the plan ${props.plan.name}`,
      actionLabel: 'Remove plan',
      danger: true,
      notice: props.plan.type === 'versions' ? 'The versions already in the repository are kept.' : 'The files already copied are kept.',
    })
    emit('changed')
  } catch (e) {
    if (e instanceof Error && e.message) error.value = e.message
  }
}
</script>

<template>
  <article class="panel-card p-5 bg-[var(--c-surface)]">
    <div class="flex min-w-0 flex-col items-start justify-between gap-3 sm:flex-row">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-medium text-[var(--c-text-1)]">{{ plan.name }}</h3>
          <span class="badge badge-muted">{{ plan.type === 'sync' ? 'Sync' : 'Versions' }}</span>
          <span v-if="!plan.enabled" class="badge badge-muted">Paused</span>
        </div>
        <p class="mt-1 break-all font-mono text-2xs text-[var(--c-text-3)]">{{ route }}</p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-1">
        <button class="btn btn-primary btn-xs" :disabled="running || starting" @click="runNow">
          <BusyLabel :busy="starting || running" :busy-label="running ? 'Running' : 'Starting'">Run now</BusyLabel>
        </button>
        <button class="btn btn-ghost btn-xs" @click="emit('edit')">Edit</button>
        <button class="btn btn-ghost btn-xs" @click="history = true">History</button>
        <button class="btn btn-ghost btn-xs text-danger" @click="remove">Remove…</button>
      </div>
    </div>

    <div v-if="plan.progress" class="mt-3 flex items-center gap-3">
      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--c-surface-deep)]" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
        <div class="h-full rounded-full bg-[var(--c-accent)] transition-all duration-700" :style="{ width: percent + '%' }" />
      </div>
      <span class="text-2xs tabular-nums text-[var(--c-text-2)]">{{ percent }}%</span>
    </div>

    <div class="mt-3 grid gap-2 text-2xs text-[var(--c-text-3)] sm:grid-cols-3">
      <span>{{ scheduleLabel(plan.schedule as Schedule) }}</span>
      <span>Next run: {{ plan.enabled ? untilLabel(plan.nextRun) : 'Paused' }}</span>
      <span :class="TONE_CLASS[last.tone]" class="break-words">{{ last.text }}</span>
    </div>
    <p v-if="error" role="alert" class="mt-2 status-text text-danger"><span class="status-tag">[ERR]</span> {{ error }}</p>

    <RunHistory v-if="history" kind="runs" :id="plan.id" :title="`History of ${plan.name}`" @close="history = false" />
  </article>
</template>
