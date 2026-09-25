<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'
import ConnectorDialog from './notifications/ConnectorDialog.vue'
import RuleDialog from './notifications/RuleDialog.vue'
import { useConfirm } from '../lib/confirm'

const { confirm } = useConfirm()

type Connector = Awaited<ReturnType<typeof trpc.notifications.connectors.list.query>>[number]
type Rule = Awaited<ReturnType<typeof trpc.notifications.rules.list.query>>[number]
type Delivery = {
  id: string
  connectorId: string
  ok: boolean
  error: string | null
  test: boolean
  at: string
  connectorName: string
}

const loading = ref(true)
const error = ref('')
const actionError = ref('')

const connectors = ref<Connector[]>([])
const rules = ref<Rule[]>([])
const deliveries = ref<Delivery[]>([])

const connectorDialog = ref<Connector | null | undefined>(undefined)
const ruleDialog = ref<Rule | null | undefined>(undefined)

const deliveriesExpanded = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [c, r, d] = await Promise.all([
      trpc.notifications.connectors.list.query(),
      trpc.notifications.rules.list.query(),
      trpc.notifications.deliveries.list.query(),
    ])
    connectors.value = c
    rules.value = r
    deliveries.value = d as Delivery[]
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load notifications settings'
  } finally {
    loading.value = false
  }
}

onMounted(load)

function connectorLabel(id: string): string {
  if (id === 'inapp') return 'In-app (bell)'
  return connectors.value.find(c => c.id === id)?.name ?? id
}

function ruleTargets(rule: Rule): string[] {
  try {
    const parsed = JSON.parse(rule.connectorIds) as unknown
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string').map(connectorLabel)
  } catch {
    return []
  }
  return []
}

function severityClass(severity: string): string {
  if (severity === 'critical') return 'bg-danger/10 text-danger'
  if (severity === 'warning') return 'bg-warning/10 text-warning'
  return 'bg-info/10 text-info'
}

function openConnectorDialog(c: Connector | null) {
  actionError.value = ''
  connectorDialog.value = c
}

function openRuleDialog(r: Rule | null) {
  actionError.value = ''
  ruleDialog.value = r
}

function closeConnectorDialog() { connectorDialog.value = undefined }
function closeRuleDialog() { ruleDialog.value = undefined }

async function reloadAfterSave() {
  connectorDialog.value = undefined
  ruleDialog.value = undefined
  await load()
}

async function toggleConnector(c: Connector) {
  actionError.value = ''
  try {
    await trpc.notifications.connectors.update.mutate({
      id: c.id,
      name: c.name,
      type: 'webhook' as const,
      method: c.method as 'POST' | 'PUT',
      url: c.url,
      headers: c.headers,
      bodyTemplate: c.bodyTemplate,
      enabled: !c.enabled,
    })
    await load()
  } catch (e: any) {
    actionError.value = e?.message ?? 'Failed to update connector'
  }
}

async function deleteConnector(c: Connector) {
  if (!await confirm(`Delete connector "${c.name}"? Rules targeting it will drop it.`, { danger: true, confirmLabel: 'Delete' })) return
  actionError.value = ''
  try {
    await trpc.notifications.connectors.delete.mutate({ id: c.id })
    await load()
  } catch (e: any) {
    actionError.value = e?.message ?? 'Failed to delete connector'
  }
}

async function toggleRule(r: Rule) {
  actionError.value = ''
  let ids: string[] = []
  try {
    const parsed = JSON.parse(r.connectorIds) as unknown
    if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    ids = []
  }
  try {
    await trpc.notifications.rules.update.mutate({
      id: r.id,
      name: r.name,
      sourcePrefix: r.sourcePrefix,
      minSeverity: r.minSeverity as 'info' | 'warning' | 'critical',
      connectorIds: ids,
      enabled: !r.enabled,
    })
    await load()
  } catch (e: any) {
    actionError.value = e?.message ?? 'Failed to update rule'
  }
}

async function deleteRule(r: Rule) {
  if (!await confirm(`Delete rule "${r.name}"?`, { danger: true, confirmLabel: 'Delete' })) return
  actionError.value = ''
  try {
    await trpc.notifications.rules.delete.mutate({ id: r.id })
    await load()
  } catch (e: any) {
    actionError.value = e?.message ?? 'Failed to delete rule'
  }
}

function formatTime(at: string | Date): string {
  const d = new Date(at)
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return `${day} ${time}`
}
</script>

<template>
  <div>
    <h2 class="text-base font-semibold text-[var(--c-text-1)] mb-1">Notifications</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">
      Route alert events to the in-app bell and webhook connectors. Rules decide which alerts each target receives.
    </p>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" retry-label="Retry" @retry="load" />

    <template v-else>
      <p v-if="actionError" class="status-text text-[var(--c-danger)] mb-4">[ERR] {{ actionError }}</p>

      <div class="space-y-6">

        <!-- Connectors -->
        <section class="panel-card bg-[var(--c-surface)]">
          <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--c-border)]">
            <p class="eyebrow">Connectors</p>
            <button class="btn btn-primary btn-xs" @click="openConnectorDialog(null)">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              Add connector
            </button>
          </div>
          <ul v-if="connectors.length > 0" class="divide-y divide-[var(--c-border)]">
            <li v-for="c in connectors" :key="c.id" class="flex items-center gap-3 px-5 py-3">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-[var(--c-text-1)] truncate">{{ c.name }}</span>
                  <span class="badge badge-muted">webhook</span>
                </div>
                <p class="text-xs text-[var(--c-text-3)] font-mono truncate mt-0.5">{{ c.method }} {{ c.url }}</p>
              </div>
              <button
                type="button" role="switch" :aria-checked="c.enabled"
                :title="c.enabled ? 'Disable connector' : 'Enable connector'"
                :class="['shrink-0 w-9 h-5 rounded-full transition-colors relative', c.enabled ? 'bg-[var(--c-accent)]' : 'bg-[var(--c-surface-deep)] border border-[var(--c-border-strong)]']"
                @click="toggleConnector(c)"
              >
                <span :class="['absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform', c.enabled ? 'translate-x-4' : 'translate-x-0.5']" />
              </button>
              <button type="button" class="btn btn-ghost btn-xs shrink-0" @click="openConnectorDialog(c)">Edit</button>
              <button type="button" class="btn btn-danger btn-xs shrink-0" @click="deleteConnector(c)">Delete</button>
            </li>
          </ul>
          <p v-else class="px-5 py-6 text-sm text-[var(--c-text-3)]">
            No connectors yet. Add one to send alerts to Discord, Slack, ntfy or any webhook.
          </p>
        </section>

        <!-- Rules -->
        <section class="panel-card bg-[var(--c-surface)]">
          <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--c-border)]">
            <p class="eyebrow">Rules</p>
            <button class="btn btn-primary btn-xs" @click="openRuleDialog(null)">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              Add rule
            </button>
          </div>
          <ul v-if="rules.length > 0" class="divide-y divide-[var(--c-border)]">
            <li v-for="r in rules" :key="r.id" class="flex items-center gap-3 px-5 py-3">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-medium text-[var(--c-text-1)]">{{ r.name }}</span>
                  <span class="badge" :class="severityClass(r.minSeverity)">{{ r.minSeverity }}</span>
                </div>
                <p class="text-xs text-[var(--c-text-3)] mt-0.5">
                  <span v-if="r.sourcePrefix" class="font-mono">{{ r.sourcePrefix }}</span>
                  <span v-else>All sources</span>
                </p>
                <div class="flex flex-wrap gap-1.5 mt-1.5">
                  <span
                    v-for="t in ruleTargets(r)" :key="t"
                    class="inline-flex items-center text-[11px] font-mono bg-[var(--c-surface-deep)] text-[var(--c-text-2)] border border-[var(--c-border)] rounded-sm px-1.5 py-0.5"
                  >{{ t }}</span>
                </div>
              </div>
              <button
                type="button" role="switch" :aria-checked="r.enabled"
                :title="r.enabled ? 'Disable rule' : 'Enable rule'"
                :class="['shrink-0 w-9 h-5 rounded-full transition-colors relative', r.enabled ? 'bg-[var(--c-accent)]' : 'bg-[var(--c-surface-deep)] border border-[var(--c-border-strong)]']"
                @click="toggleRule(r)"
              >
                <span :class="['absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform', r.enabled ? 'translate-x-4' : 'translate-x-0.5']" />
              </button>
              <button type="button" class="btn btn-ghost btn-xs shrink-0" @click="openRuleDialog(r)">Edit</button>
              <button type="button" class="btn btn-danger btn-xs shrink-0" @click="deleteRule(r)">Delete</button>
            </li>
          </ul>
          <p v-else class="px-5 py-6 text-sm text-[var(--c-text-3)]">
            No rules yet. Add a rule to route alerts to a target.
          </p>
        </section>

        <!-- Recent deliveries -->
        <section class="panel-card bg-[var(--c-surface)]">
          <button
            type="button"
            :class="['w-full flex items-center justify-between gap-3 px-5 py-3', deliveriesExpanded ? 'border-b border-[var(--c-border)]' : '']"
            @click="deliveriesExpanded = !deliveriesExpanded"
          >
            <span class="eyebrow">Recent deliveries</span>
            <svg
              :class="['w-4 h-4 text-[var(--c-text-3)] transition-transform', deliveriesExpanded ? 'rotate-180' : '']"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
            </svg>
          </button>
          <ul v-if="deliveriesExpanded && deliveries.length > 0" class="divide-y divide-[var(--c-border)]">
            <li v-for="d in deliveries" :key="d.id" class="flex items-center gap-3 px-5 py-2.5 text-xs">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="d.ok ? 'bg-[var(--c-success)]' : 'bg-[var(--c-danger)]'" />
              <span class="font-medium text-[var(--c-text-2)] shrink-0">{{ d.connectorName }}</span>
              <span v-if="d.ok" class="flex-1 text-[var(--c-text-3)]">Delivered</span>
              <span v-else class="flex-1 text-[var(--c-danger)] truncate">{{ d.error || 'Failed' }}</span>
              <span v-if="d.test" class="badge badge-muted shrink-0">Test</span>
              <span class="text-[var(--c-text-3)] tabular-nums shrink-0">{{ formatTime(d.at) }}</span>
            </li>
          </ul>
          <p v-else-if="deliveriesExpanded" class="px-5 py-6 text-sm text-[var(--c-text-3)]">
            No deliveries yet. Send test deliveries from a connector dialog.
          </p>
        </section>

      </div>

      <ConnectorDialog
        v-if="connectorDialog !== undefined"
        :connector="connectorDialog"
        @close="closeConnectorDialog"
        @saved="reloadAfterSave"
      />
      <RuleDialog
        v-if="ruleDialog !== undefined"
        :rule="ruleDialog"
        :connectors="connectors"
        @close="closeRuleDialog"
        @saved="reloadAfterSave"
      />
    </template>
  </div>
</template>
