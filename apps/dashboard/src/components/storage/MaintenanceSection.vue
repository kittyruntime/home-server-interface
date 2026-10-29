<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const { t } = useI18n()



/* Scheduled disk checks. The schedule is stored on the server and run hourly by
   a systemd timer (hsi-maintenance.timer), so it keeps running when the
   dashboard or the backend is down. Failed self-tests and RAID mismatches raise
   alerts, which notification rules can forward. */

type Data = Awaited<ReturnType<typeof trpc.storage.maintenance.query>>
type TaskId = 'smartShort' | 'smartLong' | 'raidCheck'
type Schedule = Data['tasks'][TaskId]['schedule']

const TASKS: Array<{ id: TaskId; title: string; desc: string }> = [
  { id: 'smartShort', title: t('uis.storage.MaintenanceSection.smartShortSelfTest'), desc: 'A quick electrical and mechanical test run by each disk (about 2 minutes). Disks in standby are not woken up.' },
  { id: 'smartLong',  title: t('uis.storage.MaintenanceSection.smartExtendedSelfTest'), desc: 'A full surface scan run by each disk (hours on large disks). Disks keep working normally meanwhile.' },
  { id: 'raidCheck',  title: t('uis.storage.MaintenanceSection.raidConsistencyCheck'), desc: 'Reads every array and compares the members to find silent corruption. Never started while an array is rebuilding.' },
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const data = ref<Data | null>(null)
const draft = ref<Record<TaskId, Schedule> | null>(null)
const loading = ref(true)
const error = ref('')
const saving = ref(false)
const running = ref<TaskId | null>(null)
const toast = useToast()

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await trpc.storage.maintenance.query()
    draft.value = {
      smartShort: { ...data.value.tasks.smartShort.schedule },
      smartLong:  { ...data.value.tasks.smartLong.schedule },
      raidCheck:  { ...data.value.tasks.raidCheck.schedule },
    }
  } catch (e: any) {
    error.value = e?.message ?? t('uis.storage.MaintenanceSection.failedToLoadTheMaintenance')
  } finally {
    loading.value = false
  }
}
onMounted(load)

const dirty = computed(() => !!data.value && !!draft.value &&
  TASKS.some(t => JSON.stringify(draft.value![t.id]) !== JSON.stringify(data.value!.tasks[t.id].schedule)))

async function save() {
  if (!draft.value) return
  saving.value = true
  try {
    await trpc.storage.setMaintenance.mutate(draft.value)
    toast.success(t('uis.storage.MaintenanceSection.maintenanceScheduleSaved'))
    await load()
  } catch (e: any) {
    toast.error(e?.message ?? t('uis.storage.MaintenanceSection.couldNotSaveTheSchedule'))
  } finally {
    saving.value = false
  }
}

async function runNow(id: TaskId) {
  running.value = id
  try {
    await trpc.storage.runMaintenanceNow.mutate({ task: id })
    await load()
  } catch (e: any) {
    toast.error(e?.message ?? t('uis.storage.MaintenanceSection.couldNotStartTheTask'))
  } finally {
    running.value = null
  }
}

function fmtWhen(v: string | null): string {
  if (!v) return '-'
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(v))
}

const statusClass: Record<string, string> = {
  started: 'bg-info/10 text-info',
  running: 'bg-info/10 text-info',
  passed:  'bg-success/10 text-success',
  skipped: 'bg-muted text-muted-foreground',
  error:   'bg-destructive/10 text-destructive',
  failed:  'bg-destructive/10 text-destructive',
}
</script>

<template>
  <div>
    <div class="mb-4">
      <h2 class="text-lg font-semibold text-foreground">{{ $t('ui.storage.MaintenanceSection.maintenance') }}</h2>
      <p class="text-sm text-muted-foreground mt-0.5">
        {{ $t('ui.storage.MaintenanceSection.scheduledDiskSelfTestsAnd') }}
      </p>
    </div>

    <LoadingState v-if="loading && !data" variant="block" />
    <Alert variant="destructive" v-else-if="error" class="mt-4"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <template v-else-if="data && draft">
      <Alert variant="warning" v-if="!data.timerInstalled" class="block mb-4 text-foreground" role="note">
        {{ $t('ui.storage.MaintenanceSection.theMaintenanceTimerIsNot') }}
      </Alert>

      <div class="space-y-4">
        <Card v-for="t in TASKS" :key="t.id" class="block gap-0 py-0 shadow-none p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold text-foreground">{{ t.title }}</h3>
              <p class="text-xs text-muted-foreground mt-0.5">{{ t.desc }}</p>
              <p v-if="t.id === 'raidCheck'" class="text-2xs text-muted-foreground mt-1">
                {{ $t('ui.storage.MaintenanceSection.ubuntuSMdadmPackageAlready') }}<code class="font-mono">mdcheck_start.timer</code>{{ $t('ui.storage.MaintenanceSection.ifYouScheduleOneHere') }} <code class="font-mono">sudo systemctl disable --now mdcheck_start.timer</code>.
              </p>
            </div>
            <Button variant="outline" size="xs" type="button" class="shrink-0" :disabled="running !== null" @click="runNow(t.id)">
              {{ running === t.id ? 'Starting…' : 'Run now' }}
            </Button>
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <NativeSelect wrapper-class="!w-auto" v-model="draft[t.id].every" class="!py-1 text-xs">
              <NativeSelectOption value="off">{{ $t('ui.storage.MaintenanceSection.off') }}</NativeSelectOption>
              <NativeSelectOption value="daily">{{ $t('ui.storage.MaintenanceSection.everyDay') }}</NativeSelectOption>
              <NativeSelectOption value="weekly">{{ $t('ui.storage.MaintenanceSection.everyWeek') }}</NativeSelectOption>
              <NativeSelectOption value="monthly">{{ $t('ui.storage.MaintenanceSection.everyMonth') }}</NativeSelectOption>
            </NativeSelect>
            <template v-if="draft[t.id].every === 'weekly'">
              <span class="text-muted-foreground">on</span>
              <NativeSelect wrapper-class="!w-auto" v-model.number="draft[t.id].weekday" class="!py-1 text-xs">
                <NativeSelectOption v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</NativeSelectOption>
              </NativeSelect>
            </template>
            <template v-if="draft[t.id].every === 'monthly'">
              <span class="text-muted-foreground">{{ $t('ui.storage.MaintenanceSection.onDay') }}</span>
              <NativeSelect wrapper-class="!w-auto" v-model.number="draft[t.id].day" class="!py-1 text-xs">
                <NativeSelectOption v-for="d in 28" :key="d" :value="d">{{ d }}</NativeSelectOption>
              </NativeSelect>
            </template>
            <template v-if="draft[t.id].every !== 'off'">
              <span class="text-muted-foreground">at</span>
              <NativeSelect wrapper-class="!w-auto" v-model.number="draft[t.id].hour" class="!py-1 text-xs">
                <NativeSelectOption v-for="h in 24" :key="h" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}:00</NativeSelectOption>
              </NativeSelect>
            </template>
          </div>

          <div class="mt-3 grid grid-cols-2 gap-2 text-2xs text-muted-foreground @2xl:max-w-md">
            <div>{{ $t('ui.storage.MaintenanceSection.lastRun') }} <span class="text-foreground/80">{{ fmtWhen(data.tasks[t.id].lastRun) }}</span></div>
            <div>{{ $t('ui.storage.MaintenanceSection.nextRun') }} <span class="text-foreground/80">{{ fmtWhen(data.tasks[t.id].nextRun) }}</span></div>
          </div>
          <p v-if="data.tasks[t.id].postponed" class="mt-2 status-text text-warning">
            <span class="status-tag">[WARN]</span> {{ $t('uip.storage.MaintenanceSection.notRunAt', { p0: fmtWhen(data.tasks[t.id].postponed!.at), p1: data.tasks[t.id].postponed!.reason, p2: data.tasks[t.id].schedule.every === 'off' ? 'Run it again once that is over.' : 'HSI tries again every hour.' }) }}
          </p>

          <div v-if="data.tasks[t.id].results?.length" class="mt-2 rounded-lg border border-border divide-y divide-border">
            <div v-for="(r, i) in data.tasks[t.id].results!" :key="i" class="flex items-start gap-2 px-3 py-1.5 text-2xs">
              <span class="shrink-0 rounded-sm px-1.5 py-0.5 font-semibold uppercase" :class="statusClass[r.status]">{{ r.status }}</span>
              <span class="shrink-0 font-mono text-foreground">{{ r.device ? '/dev/' + r.device : 'all' }}</span>
              <span v-if="r.serial" class="shrink-0 text-muted-foreground">{{ r.serial }}</span>
              <span class="min-w-0 break-words text-muted-foreground">{{ r.message }}</span>
            </div>
          </div>
          <p v-if="t.id !== 'raidCheck' && data.tasks[t.id].results?.length" class="mt-1 text-2xs text-muted-foreground">
            {{ $t('ui.storage.MaintenanceSection.eachDiskRunsItsTest') }}
          </p>
        </Card>
      </div>

      <div class="mt-4 flex justify-end">
        <Button size="sm" type="button" :disabled="!dirty || saving" @click="save">
          {{ saving ? 'Saving…' : 'Save schedule' }}
        </Button>
      </div>
    </template>
  </div>
</template>
