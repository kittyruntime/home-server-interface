<script setup lang="ts">
import Tip from './ui/Tip.vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDownIcon, PlusIcon } from '@lucide/vue'
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'
import ConnectorDialog from './notifications/ConnectorDialog.vue'
import RuleDialog from './notifications/RuleDialog.vue'
import { useConfirm } from '../lib/confirm'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const { confirm } = useConfirm()

type Connector = Awaited<ReturnType<typeof trpc.notifications.connectors.list.query>>[number]
type Rule = Awaited<ReturnType<typeof trpc.notifications.rules.list.query>>[number]
type Delivery = Awaited<ReturnType<typeof trpc.notifications.deliveries.list.query>>[number]

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
    deliveries.value = d
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
  if (severity === 'critical') return 'bg-destructive/10 text-destructive'
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
    await trpc.notifications.connectors.setEnabled.mutate({ id: c.id, enabled: !c.enabled })
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

function connectorTarget(c: Connector): string {
  if (c.type === 'smtp') return `${c.smtp?.host}:${c.smtp?.port} → ${c.smtp?.to.join(', ')}`
  return `${c.method} ${c.url}`
}

function deliveryDot(d: Delivery): string {
  if (d.status === 'sent') return 'bg-success'
  if (d.status === 'failed') return 'bg-destructive'
  return 'bg-warning'
}

function deliveryText(d: Delivery): string {
  if (d.status === 'sent') return 'Delivered'
  if (d.status === 'failed') return d.error || 'Failed'
  return d.attempts > 0 ? `Retrying (attempt ${d.attempts + 1} of 3): ${d.error}` : 'Queued'
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
    <h2 class="text-lg font-semibold text-foreground mb-1">Notifications</h2>
    <p class="text-sm text-muted-foreground mb-6">
      Route alert events to the in-app bell, webhooks and email. Rules decide which alerts each target receives.
    </p>

    <LoadingState v-if="loading && !connectors.length && !rules.length" />
    <ErrorState v-else-if="error" :message="error" retry-label="Retry" @retry="load" />

    <template v-else>
      <p v-if="actionError" class="status-text text-destructive mb-4">[ERR] {{ actionError }}</p>

      <div class="space-y-6">

        <!-- Connectors -->
        <section class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden bg-card">
          <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
            <p class="eyebrow">Connectors</p>
            <Button size="xs" @click="openConnectorDialog(null)">
              <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
              Add connector
            </Button>
          </div>
          <ul v-if="connectors.length > 0" class="divide-y divide-border">
            <li v-for="c in connectors" :key="c.id" class="flex items-center gap-3 px-5 py-3">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-foreground truncate">{{ c.name }}</span>
                  <Badge variant="secondary">{{ c.type === 'smtp' ? 'email' : 'webhook' }}</Badge>
                  <Badge variant="outline" v-if="c.secretsUnreadable" class="bg-destructive/10 text-destructive">secrets unreadable</Badge>
                </div>
                <p class="text-xs text-muted-foreground font-mono truncate mt-0.5">{{ connectorTarget(c) }}</p>
              </div>
              <Tip :text="c.enabled ? 'Disable connector' : 'Enable connector'"><Switch :model-value="c.enabled" @update:model-value="toggleConnector(c)" /></Tip>
              <Button variant="ghost" size="xs" type="button" class="shrink-0" @click="openConnectorDialog(c)">Edit</Button>
              <Button variant="destructive" size="xs" type="button" class="shrink-0" @click="deleteConnector(c)">Delete</Button>
            </li>
          </ul>
          <p v-else class="px-5 py-6 text-sm text-muted-foreground">
            No connectors yet. Add one to send alerts by email or to Discord, Slack, ntfy or any webhook.
          </p>
        </section>

        <!-- Rules -->
        <section class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden bg-card">
          <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
            <p class="eyebrow">Rules</p>
            <Button size="xs" @click="openRuleDialog(null)">
              <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
              Add rule
            </Button>
          </div>
          <ul v-if="rules.length > 0" class="divide-y divide-border">
            <li v-for="r in rules" :key="r.id" class="flex items-center gap-3 px-5 py-3">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-medium text-foreground">{{ r.name }}</span>
                  <Badge variant="outline" :class="severityClass(r.minSeverity)">{{ r.minSeverity }}</Badge>
                </div>
                <p class="text-xs text-muted-foreground mt-0.5">
                  <span v-if="r.sourcePrefix" class="font-mono">{{ r.sourcePrefix }}</span>
                  <span v-else>All sources</span>
                </p>
                <div class="flex flex-wrap gap-1.5 mt-1.5">
                  <span
                    v-for="t in ruleTargets(r)" :key="t"
                    class="inline-flex items-center text-2xs font-mono bg-muted text-foreground/80 border border-border rounded-sm px-1.5 py-0.5"
                  >{{ t }}</span>
                </div>
              </div>
              <Tip :text="r.enabled ? 'Disable rule' : 'Enable rule'"><Switch :model-value="r.enabled" @update:model-value="toggleRule(r)" /></Tip>
              <Button variant="ghost" size="xs" type="button" class="shrink-0" @click="openRuleDialog(r)">Edit</Button>
              <Button variant="destructive" size="xs" type="button" class="shrink-0" @click="deleteRule(r)">Delete</Button>
            </li>
          </ul>
          <p v-else class="px-5 py-6 text-sm text-muted-foreground">
            No rules yet. Add a rule to route alerts to a target.
          </p>
        </section>

        <!-- Recent deliveries -->
        <Collapsible class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden bg-card" :open="deliveriesExpanded" @update:open="v => deliveriesExpanded = v">
          <CollapsibleTrigger
            :class="['w-full flex items-center justify-between gap-3 px-5 py-3 outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50', deliveriesExpanded ? 'border-b border-border' : '']"
          >
            <span class="eyebrow">Recent deliveries</span>
            <ChevronDownIcon :class="['w-4 h-4 text-muted-foreground transition-transform', deliveriesExpanded ? 'rotate-180' : '']" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
          <ul v-if="deliveries.length > 0" class="divide-y divide-border">
            <li v-for="d in deliveries" :key="d.id" class="flex items-center gap-3 px-5 py-2.5 text-xs">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="deliveryDot(d)" />
              <span class="font-medium text-foreground/80 shrink-0">{{ d.connectorName }}</span>
              <span class="flex-1 truncate" :class="d.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'">{{ deliveryText(d) }}</span>
              <Badge variant="secondary" v-if="d.test" class="shrink-0">Test</Badge>
              <span class="text-muted-foreground tabular-nums shrink-0">{{ formatTime(d.at) }}</span>
            </li>
          </ul>
          <p v-else class="px-5 py-6 text-sm text-muted-foreground">
            No deliveries yet. Send test deliveries from a connector dialog.
          </p>
          </CollapsibleContent>
        </Collapsible>

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
