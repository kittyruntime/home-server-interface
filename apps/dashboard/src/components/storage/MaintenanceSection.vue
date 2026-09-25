<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import LoadingSpinner from '../ui/LoadingSpinner.vue'

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
  if (!v) return '—'
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(v))
}

const statusClass: Record<string, string> = {
  started: 'bg-success/10 text-success',
  skipped: 'bg-[var(--c-surface-deep)] text-[var(--c-text-3)]',
  error:   'bg-danger/10 text-danger',
}
</script>

<template>
  <div>
    <div class="mb-4">
      <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Maintenance</h2>
      <p class="text-sm text-[var(--c-text-3)] mt-0.5">
        Scheduled disk self-tests and RAID checks. They run on the server even when this page is closed;
        failures raise alerts in Monitor, which notification rules can forward.
      </p>
    </div>

    <div v-if="loading && !data" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6"><LoadingSpinner /> Loading…</div>
    <div v-else-if="error" class="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{{ error }}</div>

    <template v-else-if="data && draft">
      <div v-if="!data.timerInstalled" class="mb-4 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-[var(--c-text-1)]">
        The maintenance timer is not installed yet: schedules are saved but only run after the next HSI update installs it.
      </div>

      <div class="space-y-4">
        <div v-for="t in TASKS" :key="t.id" class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold text-[var(--c-text-1)]">{{ t.title }}</h3>
              <p class="text-xs text-[var(--c-text-3)] mt-0.5">{{ t.desc }}</p>
              <p v-if="t.id === 'raidCheck'" class="text-[11px] text-[var(--c-text-3)] mt-1">
                Ubuntu's mdadm package already runs a monthly check (<code class="font-mono">mdcheck_start.timer</code>).
                If you schedule one here, you can disable it with <code class="font-mono">sudo systemctl disable --now mdcheck_start.timer</code>.
              </p>
            </div>
            <button type="button" class="btn btn-outline btn-xs shrink-0" :disabled="running !== null" @click="runNow(t.id)">
              {{ running === t.id ? 'Starting…' : 'Run now' }}
            </button>
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <select v-model="draft[t.id].every" class="ui-input !w-auto !py-1 text-xs">
              <option value="off">Off</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
            <template v-if="draft[t.id].every === 'weekly'">
              <span class="text-[var(--c-text-3)]">on</span>
              <select v-model.number="draft[t.id].weekday" class="ui-input !w-auto !py-1 text-xs">
                <option v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</option>
              </select>
            </template>
            <template v-if="draft[t.id].every === 'monthly'">
              <span class="text-[var(--c-text-3)]">on day</span>
              <select v-model.number="draft[t.id].day" class="ui-input !w-auto !py-1 text-xs">
                <option v-for="d in 28" :key="d" :value="d">{{ d }}</option>
              </select>
            </template>
            <template v-if="draft[t.id].every !== 'off'">
              <span class="text-[var(--c-text-3)]">at</span>
              <select v-model.number="draft[t.id].hour" class="ui-input !w-auto !py-1 text-xs">
                <option v-for="h in 24" :key="h" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}:00</option>
              </select>
            </template>
          </div>

          <div class="mt-3 grid grid-cols-2 gap-2 text-[11px] text-[var(--c-text-3)] sm:max-w-md">
            <div>Last run: <span class="text-[var(--c-text-2)]">{{ fmtWhen(data.tasks[t.id].lastRun) }}</span></div>
            <div>Next run: <span class="text-[var(--c-text-2)]">{{ fmtWhen(data.tasks[t.id].nextRun) }}</span></div>
          </div>

          <div v-if="data.tasks[t.id].results?.length" class="mt-2 rounded-lg border border-[var(--c-border)] divide-y divide-[var(--c-border)]">
            <div v-for="(r, i) in data.tasks[t.id].results!" :key="i" class="flex items-start gap-2 px-3 py-1.5 text-[11px]">
              <span class="shrink-0 rounded-sm px-1.5 py-0.5 font-semibold uppercase" :class="statusClass[r.status]">{{ r.status }}</span>
              <span class="shrink-0 font-mono text-[var(--c-text-1)]">{{ r.device ? '/dev/' + r.device : 'all' }}</span>
              <span v-if="r.serial" class="shrink-0 text-[var(--c-text-3)]">{{ r.serial }}</span>
              <span class="min-w-0 break-words text-[var(--c-text-3)]">{{ r.message }}</span>
            </div>
          </div>
          <p v-if="t.id !== 'raidCheck' && data.tasks[t.id].results?.length" class="mt-1 text-[10px] text-[var(--c-text-3)]">
            "Started" means the disk accepted the test; the result appears in each disk's SMART panel when it finishes.
          </p>
        </div>
      </div>

      <div class="mt-4 flex justify-end">
        <button type="button" class="btn btn-primary btn-sm" :disabled="!dirty || saving" @click="save">
          {{ saving ? 'Saving…' : 'Save schedule' }}
        </button>
      </div>
    </template>
  </div>
</template>
