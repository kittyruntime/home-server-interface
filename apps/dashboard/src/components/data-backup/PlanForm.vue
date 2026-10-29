<script setup lang="ts">
import Tip from '../ui/Tip.vue'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { computed, onMounted, ref, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned, previewErrorOf } from '../../lib/plan'
import { randomId } from '../../lib/uuid'
import { defaultRepository, emptyPlanForm, planFormOf, planPayload, WEEKDAYS, type PlanStatusLike } from '../../lib/backup'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'


type Status = Awaited<ReturnType<typeof trpc.backup.status.query>>

const props = defineProps<{ plan: Status['plans'][number] | null; repositories: Status['repositories'] }>()
const emit = defineEmits<{ saved: []; cancel: [] }>()

const form = ref(props.plan ? planFormOf(props.plan as PlanStatusLike) : emptyPlanForm(randomId(), props.repositories[0]?.id ?? ''))
const error = ref('')

// Apps that can be stopped during a versions run, for a consistent copy of their data.
const APP_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const apps = ref<string[]>([])
onMounted(async () => {
  try {
    apps.value = (await trpc.container.app.list.query()).map(a => a.name).filter(n => APP_NAME.test(n)).sort()
  } catch { /* no app list: the choice is simply not offered */ }
})
// A stopped app that was removed since stays listed, so it can be unticked.
const appChoices = computed(() => [...new Set([...apps.value, ...form.value.versions.stopApps])].sort())

const noRepository = computed(() => props.repositories.length === 0)
// A repository added (or removed) while the form is open becomes the choice when none is.
watch(() => props.repositories, repos => {
  form.value.versions.repository = defaultRepository(form.value.versions.repository, repos)
})
const RETENTION: Array<{ key: keyof typeof form.value.versions.retention; label: string }> = [
  { key: 'keepLast', label: 'Latest' }, { key: 'keepDaily', label: 'Daily' }, { key: 'keepWeekly', label: 'Weekly' }, { key: 'keepMonthly', label: 'Monthly' },
]

async function save() {
  error.value = ''
  try {
    await applyPlanned('backup.plan.save', { plan: planPayload(form.value) }, {
      title: props.plan ? `Edit the plan ${form.value.name.trim()}` : `Create the plan ${form.value.name.trim()}`,
      actionLabel: 'Save plan',
    })
    emit('saved')
  } catch (e) {
    // A refused preview (a source off the data volumes, say) stays shown once its dialog is closed.
    const refused = previewErrorOf(e)
    if (refused) error.value = refused
    else if (e instanceof Error && e.message) error.value = e.message
  }
}
</script>

<template>
  <form class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-5 bg-card space-y-4" @submit.prevent="save">
    <div class="flex items-center justify-between gap-3">
      <h3 class="text-sm font-semibold text-foreground">{{ plan ? 'Edit plan' : 'New plan' }}</h3>
      <Badge variant="secondary" v-if="plan">{{ plan.type === 'sync' ? 'Sync' : 'Versions' }}</Badge>
    </div>

    <fieldset v-if="!plan">
      <legend class="sr-only">{{ $t('ui.backups.PlanForm.planType') }}</legend>
      <RadioGroup v-model="form.type" class="grid gap-2 sm:grid-cols-2">
      <label
        v-for="t in ([['versions', 'Versions', 'Encrypted snapshots in a repository: go back to an earlier date.'], ['sync', 'Sync', 'A mirror copy with rsync: a deletion is copied too.']] as const)"
        :key="t[0]"
        :class="['flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5', form.type === t[0] ? 'border-primary' : 'border-border']"
      >
        <RadioGroupItem :value="t[0]" class="mt-0.5" />
        <span>
          <span class="block text-sm text-foreground">{{ t[1] }}</span>
          <span class="block text-2xs text-muted-foreground">{{ t[2] }}</span>
        </span>
      </label>
      </RadioGroup>
    </fieldset>

    <label class="block text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.planName') }}
      <Input v-model="form.name" required maxlength="80" class="mt-1" :placeholder="form.type === 'sync' ? 'Nightly media mirror' : 'Photos'" />
    </label>

    <!-- Versions -->
    <template v-if="form.type === 'versions'">
      <label class="block text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.foldersToBackUpOne') }}
        <Textarea v-model="form.versions.sources" required rows="3" class="mt-1 font-mono" laceholder="/srv/data/photos&#10;/srv/data/documents" />
      </label>
      <label class="block text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.repository') }}
        <NativeSelect wrapper-class="mt-1" v-model="form.versions.repository" required :disabled="noRepository">
          <NativeSelectOption v-for="r in repositories" :key="r.id" :value="r.id">{{ r.name }}</NativeSelectOption>
        </NativeSelect>
      </label>
      <p v-if="noRepository" class="status-text text-warning"><span class="status-tag">[WARN]</span> {{ $t('ui.backups.PlanForm.addARepositoryFirstBelow') }}</p>
      <label class="block text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.exclusionsOnePatternPerLine') }}
        <Textarea v-model="form.versions.excludes" rows="2" class="mt-1 font-mono" :placeholder="$t('ui.backups.PlanForm.cache10Tmp')" />
      </label>
      <div v-if="appChoices.length">
        <p class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.appsToStopDuringThe') }}</p>
        <p class="text-2xs text-muted-foreground">{{ $t('ui.backups.PlanForm.theirFilesAreCopiedWhile') }}</p>
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          <label v-for="a in appChoices" :key="a" class="flex items-center gap-2 text-xs text-foreground/80">
            <Checkbox :model-value="form.versions.stopApps.includes(a)" @update:model-value="checked => form.versions.stopApps = checked === true ? [...form.versions.stopApps, a] : form.versions.stopApps.filter(x => x !== a)" /> {{ a }}
          </label>
        </div>
      </div>
      <div>
        <p class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.versionsToKeep') }}</p>
        <div class="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label v-for="k in RETENTION" :key="k.key" class="text-2xs text-muted-foreground">{{ k.label }}
            <Input v-model.number="form.versions.retention[k.key]" type="number" min="0" max="1000" required class="mt-1 tabular-nums" />
          </label>
        </div>
      </div>
    </template>

    <!-- Sync -->
    <template v-else>
      <label class="block text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.transferDirection') }}
        <NativeSelect wrapper-class="mt-1" v-model="form.sync.direction">
          <NativeSelectOption value="push">{{ $t('ui.backups.PlanForm.nasDestination') }}</NativeSelectOption>
          <NativeSelectOption value="pull">{{ $t('ui.backups.PlanForm.targetNas') }}</NativeSelectOption>
        </NativeSelect>
      </label>
      <label class="flex items-center gap-2 text-xs text-foreground/80"><Checkbox v-model="form.sync.remote" /> {{ $t('ui.backups.PlanForm.useARemoteSshTarget') }}</label>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="text-xs text-foreground/80">{{ form.sync.direction === 'push' ? 'NAS source' : 'Target source' }}
          <Input v-model="form.sync.source" required class="mt-1 font-mono" laceholder="/mnt/data" />
        </label>
        <label class="text-xs text-foreground/80">{{ form.sync.direction === 'push' ? 'Destination' : 'NAS destination' }}
          <Input v-model="form.sync.destination" required class="mt-1 font-mono" laceholder="/mnt/backup" />
        </label>
      </div>
      <div v-if="form.sync.remote" class="grid gap-3 sm:grid-cols-2">
        <label class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.host') }}
          <Input v-model="form.sync.remoteHost" required class="mt-1" :placeholder="$t('ui.backups.PlanForm.backupExampleNet')" />
        </label>
        <label class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.sshUser') }}
          <Input v-model="form.sync.remoteUser" required class="mt-1" laceholder="backup" />
        </label>
        <label class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.sshKeyPath') }}
          <Input v-model="form.sync.sshKeyPath" required class="mt-1 font-mono" laceholder="/root/.ssh/hsi_backup" />
        </label>
        <label class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.port') }}
          <Input v-model.number="form.sync.remotePort" type="number" min="1" max="65535" class="mt-1" />
        </label>
        <p class="sm:col-span-2 text-2xs text-muted-foreground">{{ $t('ui.backups.PlanForm.theHostMustAlreadyExist') }}</p>
      </div>
      <label class="block text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.exclusionsOnePatternPerLine') }}
        <Textarea v-model="form.sync.excludes" rows="2" class="mt-1 font-mono" :placeholder="$t('ui.backups.PlanForm.cache10Tmp2')" />
      </label>
      <div class="flex flex-wrap gap-4 text-xs text-foreground/80">
        <label class="flex items-center gap-2"><Checkbox v-model="form.sync.compress" /> {{ $t('ui.backups.PlanForm.compressTransfer') }}</label>
        <label class="flex items-center gap-2"><Checkbox v-model="form.sync.deleteExtra" /> {{ $t('ui.backups.PlanForm.mirrorDeletionsAtDestination') }}</label>
      </div>
      <p v-if="form.sync.deleteExtra" class="status-text text-warning">
        <span class="status-tag">[WARN]</span> {{ $t('ui.backups.PlanForm.mirrorModeDeletesDestinationFiles') }}
      </p>
    </template>

    <!-- Schedule -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <label class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.schedule') }}
        <NativeSelect wrapper-class="mt-1" v-model="form.schedule.every">
          <NativeSelectOption value="manual">{{ $t('ui.backups.PlanForm.manualOnly') }}</NativeSelectOption>
          <NativeSelectOption value="hourly">{{ $t('ui.backups.PlanForm.hourly') }}</NativeSelectOption>
          <NativeSelectOption value="daily">{{ $t('ui.backups.PlanForm.daily') }}</NativeSelectOption>
          <NativeSelectOption value="weekly">{{ $t('ui.backups.PlanForm.weekly') }}</NativeSelectOption>
        </NativeSelect>
      </label>
      <label v-if="form.schedule.every === 'weekly'" class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.day') }}
        <NativeSelect wrapper-class="mt-1" v-model.number="form.schedule.weekday">
          <NativeSelectOption v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</NativeSelectOption>
        </NativeSelect>
      </label>
      <label v-if="form.schedule.every === 'daily' || form.schedule.every === 'weekly'" class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.hour') }}
        <Input v-model.number="form.schedule.hour" type="number" min="0" max="23" required class="mt-1 tabular-nums" />
      </label>
      <label v-if="form.schedule.every !== 'manual'" class="text-xs text-foreground/80">{{ $t('ui.backups.PlanForm.minute') }}
        <Input v-model.number="form.schedule.minute" type="number" min="0" max="59" required class="mt-1 tabular-nums" />
      </label>
    </div>

    <div class="flex items-center justify-between gap-4">
      <span class="text-sm text-foreground/80">{{ $t('ui.backups.PlanForm.enabled') }}</span>
      <Tip text="Run on the schedule"><Switch v-model="form.enabled" /></Tip>
    </div>

    <p v-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <div class="flex gap-2">
      <Button size="sm" type="submit" :disabled="form.type === 'versions' && noRepository">{{ $t('ui.backups.PlanForm.reviewPlan') }}</Button>
      <Button variant="ghost" size="sm" type="button" @click="emit('cancel')">{{ $t('ui.backups.PlanForm.cancel') }}</Button>
    </div>
  </form>
</template>
