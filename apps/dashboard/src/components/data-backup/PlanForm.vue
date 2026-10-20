<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { randomId } from '../../lib/uuid'
import { emptyPlanForm, planFormOf, planPayload, WEEKDAYS, type PlanStatusLike } from '../../lib/backup'
import ToggleSwitch from '../ui/ToggleSwitch.vue'

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
    if (e instanceof Error && e.message) error.value = e.message
  }
}
</script>

<template>
  <form class="panel-card p-5 bg-[var(--c-surface)] space-y-4" @submit.prevent="save">
    <div class="flex items-center justify-between gap-3">
      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">{{ plan ? 'Edit plan' : 'New plan' }}</h3>
      <span v-if="plan" class="badge badge-muted">{{ plan.type === 'sync' ? 'Sync' : 'Versions' }}</span>
    </div>

    <fieldset v-if="!plan" class="grid gap-2 sm:grid-cols-2">
      <legend class="sr-only">Plan type</legend>
      <label
        v-for="t in ([['versions', 'Versions', 'Encrypted snapshots in a repository: go back to an earlier date.'], ['sync', 'Sync', 'A mirror copy with rsync: a deletion is copied too.']] as const)"
        :key="t[0]"
        :class="['flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5', form.type === t[0] ? 'border-[var(--c-accent)]' : 'border-[var(--c-border)]']"
      >
        <input v-model="form.type" type="radio" :value="t[0]" class="mt-0.5 accent-accent" />
        <span>
          <span class="block text-sm text-[var(--c-text-1)]">{{ t[1] }}</span>
          <span class="block text-2xs text-[var(--c-text-3)]">{{ t[2] }}</span>
        </span>
      </label>
    </fieldset>

    <label class="block text-xs text-[var(--c-text-2)]">Plan name
      <input v-model="form.name" required maxlength="80" class="ui-input mt-1" :placeholder="form.type === 'sync' ? 'Nightly media mirror' : 'Photos'" />
    </label>

    <!-- Versions -->
    <template v-if="form.type === 'versions'">
      <label class="block text-xs text-[var(--c-text-2)]">Folders to back up, one per line
        <textarea v-model="form.versions.sources" required rows="3" class="ui-input mt-1 font-mono" placeholder="/srv/data/photos&#10;/srv/data/documents" />
      </label>
      <label class="block text-xs text-[var(--c-text-2)]">Repository
        <select v-model="form.versions.repository" required :disabled="noRepository" class="ui-input mt-1">
          <option v-for="r in repositories" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
      </label>
      <p v-if="noRepository" class="status-text text-warning"><span class="status-tag">[WARN]</span> Add a repository first, below.</p>
      <label class="block text-xs text-[var(--c-text-2)]">Exclusions, one pattern per line
        <textarea v-model="form.versions.excludes" rows="2" class="ui-input mt-1 font-mono" placeholder=".cache&#10;*.tmp" />
      </label>
      <div v-if="appChoices.length">
        <p class="text-xs text-[var(--c-text-2)]">Apps to stop during the backup</p>
        <p class="text-2xs text-[var(--c-text-3)]">Their files are copied while they are stopped, then they start again.</p>
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          <label v-for="a in appChoices" :key="a" class="flex items-center gap-2 text-xs text-[var(--c-text-2)]">
            <input v-model="form.versions.stopApps" type="checkbox" :value="a" class="accent-accent" /> {{ a }}
          </label>
        </div>
      </div>
      <div>
        <p class="text-xs text-[var(--c-text-2)]">Versions to keep</p>
        <div class="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label v-for="k in RETENTION" :key="k.key" class="text-2xs text-[var(--c-text-3)]">{{ k.label }}
            <input v-model.number="form.versions.retention[k.key]" type="number" min="0" max="1000" required class="ui-input mt-1 tabular-nums" />
          </label>
        </div>
      </div>
    </template>

    <!-- Sync -->
    <template v-else>
      <label class="block text-xs text-[var(--c-text-2)]">Transfer direction
        <select v-model="form.sync.direction" class="ui-input mt-1">
          <option value="push">NAS → destination</option>
          <option value="pull">Target → NAS</option>
        </select>
      </label>
      <label class="flex items-center gap-2 text-xs text-[var(--c-text-2)]"><input v-model="form.sync.remote" type="checkbox" class="accent-accent" /> Use a remote SSH target</label>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="text-xs text-[var(--c-text-2)]">{{ form.sync.direction === 'push' ? 'NAS source' : 'Target source' }}
          <input v-model="form.sync.source" required class="ui-input mt-1 font-mono" placeholder="/mnt/data" />
        </label>
        <label class="text-xs text-[var(--c-text-2)]">{{ form.sync.direction === 'push' ? 'Destination' : 'NAS destination' }}
          <input v-model="form.sync.destination" required class="ui-input mt-1 font-mono" placeholder="/mnt/backup" />
        </label>
      </div>
      <div v-if="form.sync.remote" class="grid gap-3 sm:grid-cols-2">
        <label class="text-xs text-[var(--c-text-2)]">Host
          <input v-model="form.sync.remoteHost" required class="ui-input mt-1" placeholder="backup.example.net" />
        </label>
        <label class="text-xs text-[var(--c-text-2)]">SSH user
          <input v-model="form.sync.remoteUser" required class="ui-input mt-1" placeholder="backup" />
        </label>
        <label class="text-xs text-[var(--c-text-2)]">SSH key path
          <input v-model="form.sync.sshKeyPath" required class="ui-input mt-1 font-mono" placeholder="/root/.ssh/hsi_backup" />
        </label>
        <label class="text-xs text-[var(--c-text-2)]">Port
          <input v-model.number="form.sync.remotePort" type="number" min="1" max="65535" class="ui-input mt-1" />
        </label>
        <p class="sm:col-span-2 text-2xs text-[var(--c-text-3)]">The host must already exist in root's known_hosts and the private key must be mode 0600 or stricter.</p>
      </div>
      <label class="block text-xs text-[var(--c-text-2)]">Exclusions, one pattern per line
        <textarea v-model="form.sync.excludes" rows="2" class="ui-input mt-1 font-mono" placeholder=".cache/&#10;*.tmp" />
      </label>
      <div class="flex flex-wrap gap-4 text-xs text-[var(--c-text-2)]">
        <label class="flex items-center gap-2"><input v-model="form.sync.compress" type="checkbox" class="accent-accent" /> Compress transfer</label>
        <label class="flex items-center gap-2"><input v-model="form.sync.deleteExtra" type="checkbox" class="accent-accent" /> Mirror deletions at destination</label>
      </div>
      <p v-if="form.sync.deleteExtra" class="status-text text-warning">
        <span class="status-tag">[WARN]</span> Mirror mode deletes destination files that no longer exist at the source. Verify both paths before enabling it.
      </p>
    </template>

    <!-- Schedule -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <label class="text-xs text-[var(--c-text-2)]">Schedule
        <select v-model="form.schedule.every" class="ui-input mt-1">
          <option value="manual">Manual only</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
      <label v-if="form.schedule.every === 'weekly'" class="text-xs text-[var(--c-text-2)]">Day
        <select v-model.number="form.schedule.weekday" class="ui-input mt-1">
          <option v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</option>
        </select>
      </label>
      <label v-if="form.schedule.every === 'daily' || form.schedule.every === 'weekly'" class="text-xs text-[var(--c-text-2)]">Hour
        <input v-model.number="form.schedule.hour" type="number" min="0" max="23" required class="ui-input mt-1 tabular-nums" />
      </label>
      <label v-if="form.schedule.every !== 'manual'" class="text-xs text-[var(--c-text-2)]">Minute
        <input v-model.number="form.schedule.minute" type="number" min="0" max="59" required class="ui-input mt-1 tabular-nums" />
      </label>
    </div>

    <div class="flex items-center justify-between gap-4">
      <span class="text-sm text-[var(--c-text-2)]">Enabled</span>
      <ToggleSwitch v-model="form.enabled" title="Run on the schedule" />
    </div>

    <p v-if="error" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <div class="flex gap-2">
      <button type="submit" class="btn btn-primary btn-sm" :disabled="form.type === 'versions' && noRepository">Review plan</button>
      <button type="button" class="btn btn-ghost btn-sm" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>
