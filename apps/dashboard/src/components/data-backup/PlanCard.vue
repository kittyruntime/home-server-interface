<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Progress } from '@/components/ui/progress'
import { computed, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { runLabel, scheduleLabel, untilLabel, TONE_CLASS, type Schedule } from '../../lib/backup'
import BusyLabel from '../ui/BusyLabel.vue'
import RunHistory from './RunHistory.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

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
  <article class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-5 bg-card">
    <!-- Full width: long source paths wrap at the card's width, never in a squeezed column. -->
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="min-w-0 break-words text-sm font-medium text-foreground">{{ plan.name }}</h3>
        <Badge variant="secondary">{{ plan.type === 'sync' ? 'Sync' : 'Versions' }}</Badge>
        <Badge variant="secondary" v-if="!plan.enabled">{{ t('ui.backups.PlanCard.paused') }}</Badge>
      </div>
      <p class="mt-1 font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]" :title="route">{{ route }}</p>
    </div>

    <div v-if="plan.progress" class="mt-3 flex items-center gap-3">
      <Progress class="h-1.5 flex-1 rounded-full bg-muted" :model-value="percent" indicator-class="rounded-full bg-primary transition-all duration-700" />
      <span class="text-2xs tabular-nums text-foreground/80">{{ percent }}%</span>
    </div>

    <div class="mt-3 grid gap-2 text-2xs text-muted-foreground sm:grid-cols-3">
      <span>{{ scheduleLabel(plan.schedule as Schedule) }}</span>
      <span>{{ t('uip.backups.PlanCard.nextRun', { p0: plan.enabled ? untilLabel(plan.nextRun) : 'Paused' }) }}</span>
      <span :class="TONE_CLASS[last.tone]" class="break-words">{{ last.text }}</span>
    </div>
    <p v-if="error" role="alert" class="mt-2 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>

    <div class="mt-4 flex flex-wrap gap-1">
      <Button size="xs" :disabled="running || starting" @click="runNow">
        <BusyLabel :busy="starting || running" :busy-label="running ? 'Running' : 'Starting'">{{ t('ui.backups.PlanCard.runNow') }}</BusyLabel>
      </Button>
      <Button variant="ghost" size="xs" @click="emit('edit')">{{ t('ui.backups.PlanCard.edit') }}</Button>
      <Button variant="ghost" size="xs" @click="history = true">{{ t('ui.backups.PlanCard.history') }}</Button>
      <Button variant="ghost" size="xs" class="text-destructive" @click="remove">{{ t('ui.backups.PlanCard.remove') }}</Button>
    </div>

    <RunHistory v-if="history" kind="runs" :id="plan.id" :title="`History of ${plan.name}`" @close="history = false" />
  </article>
</template>
