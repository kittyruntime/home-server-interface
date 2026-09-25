<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useDesktop } from '../../lib/desktop'
import { useConfirm } from '../../lib/confirm'
import { useAlerts } from '../../composables/useAlerts'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'

type Alert = { id: string; source: string; target: string; message: string; lastSeenAt: string | Date }

const loading = ref(true)
const error   = ref('')
const alerts  = ref<Alert[]>([])

const { openApp } = useDesktop()
const { confirm } = useConfirm()
// Shared alert state behind the sidebar/dock badges: refreshed after clearing
// so the badges update immediately instead of at the next 60 s poll.
const { refresh: refreshBadges } = useAlerts()
const clearing = ref(false)
const clearError = ref('')

async function clearOne(a: Alert) {
  clearError.value = ''
  try {
    await trpc.alert.clear.mutate({ id: a.id })
    alerts.value = alerts.value.filter(x => x.id !== a.id)
    void refreshBadges()
  } catch (e: any) {
    clearError.value = e?.message ?? 'Failed to clear the alert'
  }
}

async function clearAll() {
  if (!await confirm(
    `Clear all ${alerts.value.length} alerts? Alerts whose condition is still true come back at the next check (within 5 minutes).`,
    { confirmLabel: 'Clear all' },
  )) return
  clearing.value = true
  clearError.value = ''
  try {
    await trpc.alert.clearAll.mutate()
    alerts.value = []
    void refreshBadges()
  } catch (e: any) {
    clearError.value = e?.message ?? 'Failed to clear alerts'
  } finally {
    clearing.value = false
  }
}

// Source filter — 'all' or a source prefix like 'storage.'. The list of known
// prefixes is derived from the alerts themselves so future checkers (#12) show
// up without touching this component.
const sourceFilter = ref<string>('all')
const sourcePrefixes = computed(() =>
  [...new Set(alerts.value.map(a => a.source.split('.')[0] + '.'))].sort()
)
const filteredAlerts = computed(() =>
  sourceFilter.value === 'all'
    ? alerts.value
    : alerts.value.filter(a => a.source.startsWith(sourceFilter.value))
)

const isCritical = (a: Alert) => /critical/i.test(a.message) || a.source === 'storage.raid'

async function load() {
  loading.value = true
  error.value = ''
  try {
    alerts.value = await trpc.alert.list.query() as Alert[]
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load alerts'
  } finally {
    loading.value = false
  }
}

function fmtDate(v: string | Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(v))
}

onMounted(load)
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-[var(--c-text-1)] mb-1">Alerts</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">
      Background health checks, sampled every 5 minutes. Thresholds live in
      <button @click="openApp('settings', 'alerting')" class="underline decoration-dotted underline-offset-2 hover:text-[var(--c-text-1)]">Settings &gt; Alerts</button>.
    </p>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" retry-label="Retry" @retry="load" />

    <div v-else class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] overflow-hidden">
      <div class="px-4 py-3 border-b border-[var(--c-border)] flex items-center justify-between gap-3">
        <span class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">
          Active ({{ filteredAlerts.length }})
        </span>
        <div class="flex items-center gap-3">
          <select
            v-if="sourcePrefixes.length > 1"
            v-model="sourceFilter"
            class="bg-transparent text-xs text-[var(--c-text-2)] focus:outline-none"
          >
            <option value="all">All sources</option>
            <option v-for="p in sourcePrefixes" :key="p" :value="p">{{ p.replace(/\.$/, '') }}</option>
          </select>
          <button v-if="alerts.length" type="button" class="btn btn-ghost btn-xs" :disabled="clearing" @click="clearAll">
            {{ clearing ? 'Clearing…' : 'Clear all' }}
          </button>
        </div>
      </div>
      <p v-if="clearError" class="px-4 py-2 text-xs text-danger border-b border-[var(--c-border)]">{{ clearError }}</p>
      <div v-if="!filteredAlerts.length" class="px-4 py-6 text-sm text-[var(--c-text-3)] text-center">
        No active alerts.
      </div>
      <div v-else class="divide-y divide-[var(--c-border)]">
        <div v-for="a in filteredAlerts" :key="a.id" class="px-4 py-3 flex items-start gap-3">
          <span
            class="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
            :class="isCritical(a) ? 'bg-[var(--c-danger)]' : 'bg-[var(--c-warning)]'"
          />
          <div class="min-w-0 flex-1">
            <div class="text-sm text-[var(--c-text-1)] font-mono truncate">{{ a.target }}</div>
            <div class="text-xs text-[var(--c-text-3)] mt-0.5">{{ a.message }}</div>
          </div>
          <span class="text-[10px] uppercase tracking-wider text-[var(--c-text-3)] shrink-0 mt-0.5">{{ a.source.split('.')[0] }}</span>
          <div class="text-[11px] text-[var(--c-text-3)] shrink-0 tabular-nums">{{ fmtDate(a.lastSeenAt) }}</div>
          <button type="button" class="btn btn-ghost btn-xs shrink-0 -my-0.5" title="Clear this alert" @click="clearOne(a)">Clear</button>
        </div>
      </div>
    </div>
  </div>
</template>