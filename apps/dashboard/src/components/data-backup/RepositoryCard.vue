<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { locationLabel, runLabel, untilLabel, TONE_CLASS } from '../../lib/backup'
import BusyLabel from '../ui/BusyLabel.vue'
import PasswordReveal from './PasswordReveal.vue'
import RunHistory from './RunHistory.vue'
import RestoreDialog from './RestoreDialog.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

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
  <article class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-5 bg-card">
    <!-- Full width: the location wraps at the card's width, never in a squeezed column. -->
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="min-w-0 break-words text-sm font-medium text-foreground">{{ repository.name }}</h3>
        <Badge variant="secondary">{{ TYPE_LABEL[repository.type] }}</Badge>
      </div>
      <p class="mt-1 font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]" :title="locationLabel(repository)">{{ locationLabel(repository) }}</p>
    </div>

    <div class="mt-3 grid gap-2 text-2xs text-muted-foreground sm:grid-cols-2">
      <span :class="TONE_CLASS[last.tone]" class="break-words">{{ last.text }}</span>
      <span>Next check: {{ repository.check.every === 'off' ? 'Off' : untilLabel(repository.nextCheck) }}</span>
    </div>
    <p v-if="error" role="alert" class="mt-2 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>

    <!-- Actions: the common ones first, the rarer ones on a second wrapping row. -->
    <div class="mt-4 flex flex-wrap gap-1">
      <Button size="xs" @click="restoring = true">{{ t('ui.backups.RepositoryCard.browseAndRestore') }}</Button>
      <Button variant="outline" size="xs" :disabled="checking || !!starting" @click="check(false)">
        <BusyLabel :busy="starting === 'quick' || checking" :busy-label="checking ? 'Checking' : 'Starting'">{{ t('ui.backups.RepositoryCard.check') }}</BusyLabel>
      </Button>
    </div>
    <div class="mt-1 flex flex-wrap gap-1">
      <Button variant="ghost" size="xs" :disabled="checking || !!starting" :tooltip="t('ui.backups.RepositoryCard.readEveryStoredFileBack')" @click="check(true)">
        <BusyLabel :busy="starting === 'full'">{{ t('ui.backups.RepositoryCard.fullCheck') }}</BusyLabel>
      </Button>
      <Button variant="ghost" size="xs" v-if="repository.hasPassword" @click="revealing = true">{{ t('ui.backups.RepositoryCard.showPassword') }}</Button>
      <Button variant="ghost" size="xs" @click="history = true">{{ t('ui.backups.RepositoryCard.history') }}</Button>
      <Button variant="ghost" size="xs" @click="emit('edit')">{{ t('ui.backups.RepositoryCard.edit') }}</Button>
      <Button variant="ghost" size="xs" class="text-destructive" @click="remove">{{ t('ui.backups.RepositoryCard.remove') }}</Button>
    </div>

    <PasswordReveal v-if="revealing" mode="ask" :repository="repository" @close="revealing = false" />
    <RestoreDialog v-if="restoring" :repository="repository" :plans="plans" @close="restoring = false" />
    <RunHistory v-if="history" kind="checks" :id="repository.id" :title="`Checks of ${repository.name}`" @close="history = false" />
  </article>
</template>
