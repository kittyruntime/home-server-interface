<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

/* Scheduled disk checks. The schedule is stored on the server and run hourly by
   a systemd timer (hsi-maintenance.timer), so it keeps running when the
   dashboard or the backend is down. Failed self-tests and RAID mismatches raise
   alerts, which notification rules can forward. */

type Data = Awaited<ReturnType<typeof trpc.storage.maintenance.query>>
type TaskId = 'smartShort' | 'smartLong' | 'raidCheck'
type Schedule = Data['tasks'][TaskId]['schedule']

const TASKS: Array<{ id: TaskId; title: string; desc: string }> = [
  { id: 'smartShort', title: 'SMART short self-test', desc: 'A quick electrical and mechanical test run by each disk (about 2 minutes). Disks in standby are not woken up.' },
  { id: 'smartLong',  title: 'SMART extended self-test', desc: 'A full surface scan run by each disk (hours on large disks). Disks keep working normally meanwhile.' },
  { id: 'raidCheck',  title: 'RAID consistency check', desc: 'Reads every array and compares the members to find silent corruption. Never started while an array is rebuilding.' },
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
    error.value = e?.message ?? 'Failed to load the maintenance schedule'
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
    toast.success('Maintenance schedule saved')
    await load()
  } catch (e: any) {
    toast.error(e?.message ?? 'Could not save the schedule')
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
    toast.error(e?.message ?? 'Could not start the task')
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
      <h2 class="text-lg font-semibold text-foreground">Maintenance</h2>
      <p class="text-sm text-muted-foreground mt-0.5">
        Scheduled disk self-tests and RAID checks. They run on the server even when this page is closed;
        failures raise alerts in Monitor, which notification rules can forward.
      </p>
    </div>

    <LoadingState v-if="loading && !data" variant="block" />
    <Alert variant="destructive" v-else-if="error" class="mt-4"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <template v-else-if="data && draft">
      <Alert variant="warning" v-if="!data.timerInstalled" class="block mb-4 text-foreground" role="note">
        The maintenance timer is not installed yet: schedules are saved but only run after the next HSI update installs it.
      </Alert>

      <div class="space-y-4">
        <Card v-for="t in TASKS" :key="t.id" class="block gap-0 py-0 shadow-none p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold text-foreground">{{ t.title }}</h3>
              <p class="text-xs text-muted-foreground mt-0.5">{{ t.desc }}</p>
              <p v-if="t.id === 'raidCheck'" class="text-2xs text-muted-foreground mt-1">
                Ubuntu's mdadm package already runs a monthly check (<code class="font-mono">mdcheck_start.timer</code>).
                If you schedule one here, you can disable it with <code class="font-mono">sudo systemctl disable --now mdcheck_start.timer</code>.
              </p>
            </div>
            <Button variant="outline" size="xs" type="button" class="shrink-0" :disabled="running !== null" @click="runNow(t.id)">
              {{ running === t.id ? 'Starting…' : 'Run now' }}
            </Button>
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <NativeSelect wrapper-class="!w-auto" v-model="draft[t.id].every" class="!py-1 text-xs">
              <NativeSelectOption value="off">Off</NativeSelectOption>
              <NativeSelectOption value="daily">Every day</NativeSelectOption>
              <NativeSelectOption value="weekly">Every week</NativeSelectOption>
              <NativeSelectOption value="monthly">Every month</NativeSelectOption>
            </NativeSelect>
            <template v-if="draft[t.id].every === 'weekly'">
              <span class="text-muted-foreground">on</span>
              <NativeSelect wrapper-class="!w-auto" v-model.number="draft[t.id].weekday" class="!py-1 text-xs">
                <NativeSelectOption v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</NativeSelectOption>
              </NativeSelect>
            </template>
            <template v-if="draft[t.id].every === 'monthly'">
              <span class="text-muted-foreground">on day</span>
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
            <div>Last run: <span class="text-foreground/80">{{ fmtWhen(data.tasks[t.id].lastRun) }}</span></div>
            <div>Next run: <span class="text-foreground/80">{{ fmtWhen(data.tasks[t.id].nextRun) }}</span></div>
          </div>
          <p v-if="data.tasks[t.id].postponed" class="mt-2 status-text text-warning">
            <span class="status-tag">[WARN]</span> Not run at {{ fmtWhen(data.tasks[t.id].postponed!.at) }}: {{ data.tasks[t.id].postponed!.reason }}.
            {{ data.tasks[t.id].schedule.every === 'off' ? 'Run it again once that is over.' : 'HSI tries again every hour.' }}
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
            Each disk runs its test on its own: Running shows how much is left, then Passed or Failed. A failed test also raises an alert in Monitor.
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
