<script setup lang="ts">
import { computed, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { locationLabel, runLabel, untilLabel, TONE_CLASS } from '../../lib/backup'
import BusyLabel from '../ui/BusyLabel.vue'
import PasswordReveal from './PasswordReveal.vue'
import RunHistory from './RunHistory.vue'
import RestoreDialog from './RestoreDialog.vue'

type Status = Awaited<ReturnType<typeof trpc.backup.status.query>>
type Repository = Status['repositories'][number]

const props = defineProps<{ repository: Repository; plans: Status['plans'] }>()
const emit = defineEmits<{ edit: []; changed: [] }>()

const TYPE_LABEL: Record<Repository['type'], string> = { local: 'Local', sftp: 'SFTP', s3: 'S3', rest: 'REST' }

const error = ref('')
const starting = ref<'' | 'quick' | 'full'>('')
const revealing = ref(false)
const history = ref(false)
const restoring = ref(false)

const checking = computed(() => props.repository.lastCheck?.status === 'running')
const last = computed(() => {
  const l = runLabel(props.repository.lastCheck)
  return props.repository.lastCheck ? l : { ...l, text: 'Never checked' }
})

async function check(full: boolean) {
  error.value = ''
  starting.value = full ? 'full' : 'quick'
  try {
    await trpc.backup.checkNow.mutate({ id: props.repository.id, full })
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : 'Failed to start the check'
  } finally {
    starting.value = ''
  }
}

async function remove() {
  error.value = ''
  try {
    await applyPlanned('backup.repository.remove', { id: props.repository.id }, {
      title: `Remove the repository ${props.repository.name}`,
      actionLabel: 'Remove repository',
      danger: true,
      notice: 'HSI forgets the password of this repository. Without it, the backups stored there cannot be read.',
      acknowledge: 'I kept the password of this repository, or I no longer need these backups',
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
          <h3 class="text-sm font-medium text-[var(--c-text-1)]">{{ repository.name }}</h3>
          <span class="badge badge-muted">{{ TYPE_LABEL[repository.type] }}</span>
        </div>
        <p class="mt-1 break-all font-mono text-2xs text-[var(--c-text-3)]">{{ locationLabel(repository) }}</p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-1">
        <button class="btn btn-outline btn-xs" :disabled="checking || !!starting" @click="check(false)">
          <BusyLabel :busy="starting === 'quick' || checking" :busy-label="checking ? 'Checking' : 'Starting'">Check</BusyLabel>
        </button>
        <button class="btn btn-ghost btn-xs" :disabled="checking || !!starting" title="Read every stored file back; slow on a large repository" @click="check(true)">
          <BusyLabel :busy="starting === 'full'">Full check</BusyLabel>
        </button>
        <button class="btn btn-outline btn-xs" @click="restoring = true">Browse and restore…</button>
        <button v-if="repository.hasPassword" class="btn btn-ghost btn-xs" @click="revealing = true">Show password…</button>
        <button class="btn btn-ghost btn-xs" @click="history = true">History</button>
        <button class="btn btn-ghost btn-xs" @click="emit('edit')">Edit</button>
        <button class="btn btn-ghost btn-xs text-danger" @click="remove">Remove…</button>
      </div>
    </div>

    <div class="mt-3 grid gap-2 text-2xs text-[var(--c-text-3)] sm:grid-cols-2">
      <span :class="TONE_CLASS[last.tone]" class="break-words">{{ last.text }}</span>
      <span>Next check: {{ repository.check.every === 'off' ? 'Off' : untilLabel(repository.nextCheck) }}</span>
    </div>
    <p v-if="error" role="alert" class="mt-2 status-text text-danger"><span class="status-tag">[ERR]</span> {{ error }}</p>

    <PasswordReveal v-if="revealing" mode="ask" :repository="repository" @close="revealing = false" />
    <RestoreDialog v-if="restoring" :repository="repository" :plans="plans" @close="restoring = false" />
    <RunHistory v-if="history" kind="checks" :id="repository.id" :title="`Checks of ${repository.name}`" @close="history = false" />
  </article>
</template>
