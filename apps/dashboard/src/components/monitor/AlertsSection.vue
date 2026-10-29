<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatDateTime } from '../../lib/format-date'
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useDesktop } from '../../lib/desktop'
import { useConfirm } from '../../lib/confirm'
import { useAlerts } from '../../composables/useAlerts'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

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

// Source filter: 'all' or a source prefix like 'storage.'. The list of known
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


onMounted(load)
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-foreground mb-1">{{ t('ui.monitor.AlertsSection.alerts') }}</h2>
    <p class="text-sm text-muted-foreground mb-6">
      {{ t('ui.monitor.AlertsSection.backgroundHealthChecksSampledEvery') }}
      <Button variant="link" @click="openApp('settings', 'alerting')" class="h-auto p-0 hover:text-foreground">{{ t('ui.monitor.AlertsSection.settingsAlertThresholds') }}</Button>.
    </p>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" :retry-label="t('ui.monitor.AlertsSection.retry')" @retry="load" />

    <Card v-else class="block gap-0 py-0 shadow-none overflow-hidden">
      <div class="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <span class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">
          Active ({{ filteredAlerts.length }})
        </span>
        <div class="flex items-center gap-3">
          <Select v-if="sourcePrefixes.length > 1" v-model="sourceFilter">
            <SelectTrigger size="sm" class="h-7 text-xs" :aria-label="t('ui.monitor.AlertsSection.filterBySource')">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{{ t('ui.monitor.AlertsSection.allSources') }}</SelectItem>
              <SelectItem v-for="p in sourcePrefixes" :key="p" :value="p">{{ p.replace(/\.$/, '') }}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="xs" v-if="alerts.length" type="button" :disabled="clearing" @click="clearAll">
            {{ clearing ? 'Clearing…' : 'Clear all' }}
          </Button>
        </div>
      </div>
      <p v-if="clearError" role="alert" class="px-4 py-2 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ clearError }}</p>
      <div v-if="!filteredAlerts.length" class="px-4 py-6 text-sm text-muted-foreground text-center">
        {{ t('ui.monitor.AlertsSection.noActiveAlerts') }}
      </div>
      <div v-else class="divide-y divide-border">
        <div v-for="a in filteredAlerts" :key="a.id" class="px-4 py-3 flex items-start gap-3">
          <span
            class="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
            :class="isCritical(a) ? 'bg-destructive' : 'bg-warning'"
          />
          <div class="min-w-0 flex-1">
            <div class="text-sm text-foreground font-mono truncate">{{ a.target }}</div>
            <div class="text-xs text-muted-foreground mt-0.5">{{ a.message }}</div>
          </div>
          <span class="text-2xs uppercase tracking-caps text-muted-foreground shrink-0 mt-0.5">{{ a.source.split('.')[0] }}</span>
          <div class="text-2xs text-muted-foreground shrink-0 tabular-nums">{{ formatDateTime(a.lastSeenAt) }}</div>
          <Button variant="ghost" size="xs" type="button" class="shrink-0 -my-0.5" :tooltip="t('ui.monitor.AlertsSection.clearThisAlert')" @click="clearOne(a)">{{ t('ui.monitor.AlertsSection.clear') }}</Button>
        </div>
      </div>
    </Card>
  </div>
</template>