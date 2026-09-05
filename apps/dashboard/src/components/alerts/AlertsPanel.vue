<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useDesktop } from '../../lib/desktop'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'

type Alert = { id: string; source: string; target: string; message: string; lastSeenAt: string | Date }

const loading = ref(true)
const error   = ref('')
const alerts  = ref<Alert[]>([])

const { openApp } = useDesktop()

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
  <div class="h-full overflow-y-auto">
    <div class="p-4 sm:p-8 max-w-5xl">
      <div class="flex items-start justify-between mb-6">
        <div>
          <h2 class="text-lg font-semibold text-[var(--c-text-1)] mb-1">Alerts</h2>
          <p class="text-sm text-[var(--c-text-3)]">
            Background checks, sampled every 5 minutes.
          </p>
        </div>
        <button
          @click="openApp('settings', 'alerting')"
          class="btn btn-outline btn-xs shrink-0 inline-flex items-center gap-1.5"
        >
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
          Configure thresholds
        </button>
      </div>

      <LoadingState v-if="loading" />
      <ErrorState v-else-if="error" :message="error" retry-label="Retry" @retry="load" />

      <div v-else class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] overflow-hidden">
        <div class="px-4 py-3 border-b border-[var(--c-border)] flex items-center justify-between gap-3">
          <span class="text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">
            Active ({{ filteredAlerts.length }})
          </span>
          <select
            v-if="sourcePrefixes.length > 1"
            v-model="sourceFilter"
            class="bg-transparent text-xs text-[var(--c-text-2)] focus:outline-none"
          >
            <option value="all">All sources</option>
            <option v-for="p in sourcePrefixes" :key="p" :value="p">{{ p.replace(/\.$/, '') }}</option>
          </select>
        </div>
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
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
