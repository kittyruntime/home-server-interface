<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RefreshCwIcon, SearchIcon } from '@lucide/vue'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime } from '../lib/format-date'
import LoadingSpinner from './ui/LoadingSpinner.vue'
import { ref, watch, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { actionLabel, actionCategory, categoryClass } from '../lib/audit-labels'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'
import EmptyState from './ui/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { BotIcon } from '@lucide/vue'

const { t } = useI18n()

type AuditEntry = Awaited<ReturnType<typeof trpc.audit.list.query>>['entries'][number]

const PAGE_SIZE = 50

const page          = ref(0)
const filterAction  = ref('')
// Every action, only the dashboard's, or only AI assistants' (#138).
const filterVia     = ref<'' | 'dashboard' | 'mcp'>('')
const loading       = ref(false)
const error         = ref('')
const entries       = ref<AuditEntry[]>([])
const total         = ref(0)
const pages         = ref(1)
const selectedEntry = ref<AuditEntry | null>(null)

async function load() {
  loading.value = true
  error.value   = ''
  try {
    const res = await trpc.audit.list.query({
      page:   page.value,
      limit:  PAGE_SIZE,
      action: filterAction.value || undefined,
      via:    filterVia.value || undefined,
    })
    entries.value = res.entries
    total.value   = res.total
    pages.value   = Math.max(1, Math.ceil(res.total / PAGE_SIZE))
  } catch (e: unknown) {
    // Surface the failure instead of falling through to the empty state, which
    // would misrepresent a load error as "no activity".
    error.value = (e as { message?: string })?.message ?? t('uis.settings.AuditLogSection.failedToLoadTheAudit')
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([page], load)
watch([filterAction, filterVia], () => { page.value = 0; load() })






function parseMeta(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return null }
}
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-foreground mb-1">{{ t('ui.monitor.AuditLogSection.auditLog') }}</h2>
    <p class="text-sm text-muted-foreground mb-6">{{ t('ui.monitor.AuditLogSection.allActionsPerformedByAuthenticated') }}</p>

    <!-- Filter -->
    <div class="flex gap-3 mb-5 min-w-0">
      <div class="relative flex-1 min-w-0">
        <SearchIcon class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
        <Input v-model="filterAction" :placeholder="t('ui.monitor.AuditLogSection.filterByAction')"
          class="w-full pl-8 pr-3 py-2 text-sm" />
      </div>
      <NativeSelect v-model="filterVia" wrapper-class="w-44 shrink-0" :aria-label="t('aiAccess.auditFilter')">
        <NativeSelectOption value="">{{ t('aiAccess.auditAll') }}</NativeSelectOption>
        <NativeSelectOption value="dashboard">{{ t('aiAccess.auditDashboard') }}</NativeSelectOption>
        <NativeSelectOption value="mcp">{{ t('aiAccess.auditAssistant') }}</NativeSelectOption>
      </NativeSelect>
      <Button variant="outline" size="icon" :disabled="loading" :tooltip="t('ui.monitor.AuditLogSection.refresh')" :aria-label="t('ui.monitor.AuditLogSection.refreshAuditLog')" @click="load">
        <LoadingSpinner v-if="loading" class="text-base" />
        <RefreshCwIcon v-else class="size-4" aria-hidden="true" />
      </Button>
    </div>

    <!-- Loading -->
    <LoadingState v-if="loading && !entries.length" />

    <!-- Error -->
    <ErrorState v-else-if="error" :message="error" :retry-label="t('ui.monitor.AuditLogSection.retry')" @retry="load" />

    <!-- Empty -->
    <EmptyState
      v-else-if="!entries.length"
      :message="filterAction || filterVia ? 'No audit entries match this filter.' : 'No audit entries yet.'"
      :description="filterAction || filterVia ? undefined : 'Actions taken by admins and privileged operations will appear here.'"
    >
      <template v-if="filterAction || filterVia" #action>
        <Button variant="outline" size="sm" @click="filterAction = ''; filterVia = ''">{{ t('ui.monitor.AuditLogSection.clearFilter') }}</Button>
      </template>
    </EmptyState>

    <!-- Table -->
    <template v-else>
      <div class="space-y-2 sm:hidden">
        <article v-for="entry in entries" :key="entry.id" class="rounded-xl border border-border bg-card p-3" @click="selectedEntry = selectedEntry?.id === entry.id ? null : entry">
          <div class="flex items-start justify-between gap-3"><div class="min-w-0"><span :class="['inline-flex text-2xs font-semibold px-2 py-0.5 rounded-sm border', categoryClass[actionCategory(entry.action)]]">{{ actionLabel(entry.action) }}</span><p v-if="entry.target" class="mt-1.5 truncate font-mono text-xs text-foreground/80" :title="entry.target">{{ entry.target }}</p></div><span :class="entry.success ? 'text-success' : 'text-destructive'" class="shrink-0 text-xs font-semibold">{{ entry.success ? 'OK' : 'Fail' }}</span></div>
          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground"><span>{{ formatDateTime(entry.createdAt, { seconds: true }) }}</span><span>{{ entry.user?.displayName || entry.user?.username || 'System' }}<template v-if="entry.via === 'mcp'"> · {{ t('aiAccess.auditAssistant') }}</template></span><span class="font-mono">{{ entry.ip ?? '-' }}</span></div>
          <div v-if="selectedEntry?.id === entry.id" class="mt-3 border-t border-border pt-3"><p class="break-all font-mono text-2xs text-muted-foreground">{{ entry.action }}</p><pre v-if="parseMeta(entry.meta)" class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-2 text-2xs text-foreground/80">{{ JSON.stringify(parseMeta(entry.meta), null, 2) }}</pre></div>
        </article>
      </div>
      <div class="hidden rounded-xl border border-border overflow-hidden sm:block">
        <Table class="w-full text-sm border-collapse">
          <TableHeader>
            <TableRow class="bg-muted border-b border-border text-muted-foreground text-xs uppercase tracking-caps">
              <TableHead class="text-left px-4 py-3 font-medium w-44">{{ t('ui.monitor.AuditLogSection.time') }}</TableHead>
              <TableHead class="text-left px-4 py-3 font-medium w-32">{{ t('ui.monitor.AuditLogSection.user') }}</TableHead>
              <TableHead class="text-left px-4 py-3 font-medium">{{ t('ui.monitor.AuditLogSection.action') }}</TableHead>
              <TableHead class="text-left px-4 py-3 font-medium max-w-0">{{ t('ui.monitor.AuditLogSection.target') }}</TableHead>
              <TableHead class="text-left px-4 py-3 font-medium w-28">IP</TableHead>
              <TableHead class="text-center px-4 py-3 font-medium w-16">{{ t('ui.monitor.AuditLogSection.status') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody class="divide-y divide-border">
            <template v-for="entry in entries" :key="entry.id">
              <TableRow @click="selectedEntry = selectedEntry?.id === entry.id ? null : entry"
                :class="['cursor-pointer transition-colors hover:bg-accent/40',
                  selectedEntry?.id === entry.id ? 'bg-primary/5' : '',
                  !entry.success ? 'bg-destructive/4' : '']">

                <TableCell class="px-4 py-2.5 text-xs text-muted-foreground font-mono whitespace-nowrap">
                  {{ formatDateTime(entry.createdAt, { seconds: true }) }}
                </TableCell>
                <TableCell class="px-4 py-2.5">
                  <span v-if="entry.user" class="text-foreground font-medium text-xs">
                    {{ entry.user.displayName || entry.user.username }}
                  </span>
                  <span v-if="entry.via === 'mcp'" class="ml-1.5 inline-flex items-center gap-1 text-2xs text-violet" :title="t('aiAccess.auditAssistant')">
                    <BotIcon class="size-3" aria-hidden="true" /><span class="sr-only">{{ t('aiAccess.auditAssistant') }}</span>
                  </span>
                  <span v-else class="text-muted-foreground text-xs">-</span>
                </TableCell>
                <TableCell class="px-4 py-2.5">
                  <span :class="['inline-flex text-2xs font-semibold px-2 py-0.5 rounded-sm border', categoryClass[actionCategory(entry.action)]]">
                    {{ actionLabel(entry.action) }}
                  </span>
                </TableCell>
                <TableCell class="px-4 py-2.5 max-w-0">
                  <span v-if="entry.target" class="font-mono text-xs text-foreground/80 truncate block" :title="entry.target">
                    {{ entry.target }}
                  </span>
                  <span v-else class="text-muted-foreground text-xs">-</span>
                </TableCell>
                <TableCell class="px-4 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {{ entry.ip ?? '-' }}
                </TableCell>
                <TableCell class="px-4 py-2.5 text-center">
                  <span v-if="entry.success"
                    class="inline-flex items-center gap-1 text-2xs font-semibold px-1.5 py-0.5 rounded-sm bg-success/10 text-success">
                    <span class="w-1.5 h-1.5 rounded-full bg-success"/>OK
                  </span>
                  <span v-else
                    class="inline-flex items-center gap-1 text-2xs font-semibold px-1.5 py-0.5 rounded-sm bg-destructive/10 text-destructive">
                    <span class="w-1.5 h-1.5 rounded-full bg-destructive"/>{{ t('ui.monitor.AuditLogSection.fail') }}
                  </span>
                </TableCell>
              </TableRow>

              <!-- Expanded detail row -->
              <TableRow v-if="selectedEntry?.id === entry.id" :key="'detail-' + entry.id">
                <TableCell colspan="6" class="px-4 pb-4 pt-2 bg-muted/50">
                  <div class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground mb-2">{{ t('ui.monitor.AuditLogSection.detail') }}</div>
                  <div class="grid grid-cols-2 gap-x-8 gap-y-1 text-xs mb-3">
                    <div><span class="text-muted-foreground">ID </span><span class="font-mono text-foreground/80">{{ entry.id }}</span></div>
                    <div><span class="text-muted-foreground">{{ t('ui.monitor.AuditLogSection.action') }} </span><span class="font-mono text-foreground/80">{{ entry.action }}</span></div>
                    <div v-if="entry.user">
                      <span class="text-muted-foreground">{{ t('ui.monitor.AuditLogSection.user') }} </span>
                      <span class="text-foreground/80">{{ entry.user.displayName || entry.user.username }} ({{ entry.userId }})</span>
                    </div>
                    <div v-if="entry.target"><span class="text-muted-foreground">{{ t('ui.monitor.AuditLogSection.target') }} </span><span class="font-mono text-foreground/80">{{ entry.target }}</span></div>
                    <div v-if="entry.via === 'mcp'"><span class="text-muted-foreground">{{ t('aiAccess.auditVia') }} </span><span class="font-mono text-foreground/80">{{ entry.tokenId }}</span></div>
                  </div>
                  <template v-if="parseMeta(entry.meta)">
                    <div class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground mb-1.5">{{ t('ui.monitor.AuditLogSection.input') }}</div>
                    <pre class="text-2xs font-mono bg-muted border border-border rounded-lg px-3 py-2 overflow-x-auto text-foreground/80 whitespace-pre-wrap">{{ JSON.stringify(parseMeta(entry.meta), null, 2) }}</pre>
                  </template>
                </TableCell>
              </TableRow>
            </template>
          </TableBody>
        </Table>
      </div>

      <!-- Pagination -->
      <div class="flex items-center justify-between mt-4 text-sm text-muted-foreground">
        <span>{{ total.toLocaleString() }} entr{{ total === 1 ? 'y' : 'ies' }}</span>
        <div class="flex items-center gap-1">
          <Button variant="outline" size="xs" @click="page--" :disabled="page === 0 || loading"
            >
            {{ t('ui.monitor.AuditLogSection.prev') }}
          </Button>
          <span class="px-3 py-1.5 text-xs">{{ page + 1 }} / {{ pages }}</span>
          <Button variant="outline" size="xs" @click="page++" :disabled="page >= pages - 1 || loading"
            >
            {{ t('ui.monitor.AuditLogSection.next') }}
          </Button>
        </div>
      </div>
    </template>
  </div>
</template>
