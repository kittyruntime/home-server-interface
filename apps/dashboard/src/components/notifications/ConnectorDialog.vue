<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import Modal from '../ui/Modal.vue'

type PublicConnector = Awaited<ReturnType<typeof trpc.notifications.connectors.list.query>>[number]
type Presets = Awaited<ReturnType<typeof trpc.notifications.connectors.presets.query>>
type WebhookPreset = Presets['webhook'][number]

const props = defineProps<{ connector: null | PublicConnector }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const presets = ref<Presets | null>(null)
const type = ref<'webhook' | 'smtp'>(props.connector?.type ?? 'webhook')
const format = ref(type.value === 'smtp' ? 'generic' : 'custom')
const name = ref(props.connector?.name ?? '')
const enabled = ref(props.connector?.enabled ?? true)
const rateLimit = ref(props.connector?.rateLimitPerMinute ?? 10)

// Webhook fields. Saved secrets come back masked and are kept when unchanged.
const method = ref(props.connector?.method ?? 'POST')
const url = ref(props.connector?.type === 'webhook' ? props.connector.url : '')
const bodyTemplate = ref(props.connector?.bodyTemplate ?? '')
const headerRows = ref<Array<{ key: string; value: string }>>(headersToRows(props.connector?.headers ?? '{}'))

// SMTP fields. The saved password is never sent back: empty means "keep".
const smtp = ref({
  host: props.connector?.smtp?.host ?? '',
  port: props.connector?.smtp?.port ?? 587,
  security: (props.connector?.smtp?.security ?? 'starttls') as 'starttls' | 'tls' | 'none',
  username: props.connector?.smtp?.username ?? '',
  password: '',
  from: props.connector?.smtp?.from ?? '',
  to: (props.connector?.smtp?.to ?? []).join(', '),
  subjectTemplate: props.connector?.smtp?.subjectTemplate ?? '',
  bodyTemplate: props.connector?.smtp?.bodyTemplate ?? '',
})
const passwordSet = props.connector?.smtp?.passwordSet ?? false

const saving = ref(false)
const saveError = ref('')

function headersToRows(json: string) {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    return Object.entries(parsed).map(([k, v]) => ({ key: k, value: String(v ?? '') }))
  } catch { return [] }
}

function applyPreset(p: WebhookPreset) {
  method.value = p.method
  url.value = p.url
  bodyTemplate.value = p.bodyTemplate
  headerRows.value = headersToRows(p.headers)
}

function addHeaderRow() { headerRows.value.push({ key: '', value: '' }) }
function removeHeaderRow(i: number) { headerRows.value.splice(i, 1) }

const headersJson = computed(() =>
  JSON.stringify(Object.fromEntries(headerRows.value.map(r => [r.key, r.value]).filter(([k]) => k)))
)

const formatOptions = computed(() => type.value === 'smtp' ? presets.value?.smtp ?? [] : presets.value?.webhook ?? [])

watch(format, id => {
  if (type.value === 'smtp') {
    const p = presets.value?.smtp.find(x => x.id === id)
    if (p) Object.assign(smtp.value, { host: p.host, port: p.port, security: p.security })
  } else {
    const p = presets.value?.webhook.find(x => x.id === id)
    if (p) applyPreset(p)
  }
})

watch(type, t => { format.value = t === 'smtp' ? 'generic' : 'custom' })

onMounted(async () => {
  try {
    presets.value = await trpc.notifications.connectors.presets.query()
  } catch {
    presets.value = null
  }
  if (!props.connector) {
    const custom = presets.value?.webhook.find(p => p.id === 'custom')
    if (custom) applyPreset(custom)
  }
  if (!smtp.value.subjectTemplate) smtp.value.subjectTemplate = presets.value?.emailDefaults.subjectTemplate ?? ''
  if (!smtp.value.bodyTemplate) smtp.value.bodyTemplate = presets.value?.emailDefaults.bodyTemplate ?? ''
})

const recipients = computed(() => smtp.value.to.split(/[,\s]+/).map(s => s.trim()).filter(Boolean))

const part = computed(() => type.value === 'smtp'
  ? { type: 'smtp' as const, smtp: { ...smtp.value, port: Number(smtp.value.port), to: recipients.value } }
  : { type: 'webhook' as const, method: method.value as 'POST' | 'PUT', url: url.value, headers: headersJson.value, bodyTemplate: bodyTemplate.value })

const canSubmit = computed(() => type.value === 'smtp'
  ? !!smtp.value.host.trim() && !!smtp.value.from.trim() && recipients.value.length > 0
  : !!url.value.trim())

const previewInput = computed(() => ({ ...part.value, id: props.connector?.id }))

const preview = ref<Awaited<ReturnType<typeof trpc.notifications.renderPreview.query>> | null>(null)
const previewError = ref('')

let previewTimer: ReturnType<typeof setTimeout> | null = null
let previewSeq = 0

async function runPreview() {
  if (!canSubmit.value) {
    preview.value = null
    previewError.value = ''
    return
  }
  const seq = ++previewSeq
  try {
    const r = await trpc.notifications.renderPreview.query(previewInput.value)
    if (seq === previewSeq) {
      preview.value = r
      previewError.value = ''
    }
  } catch (e: any) {
    if (seq === previewSeq) {
      preview.value = null
      previewError.value = e?.message ?? 'Preview failed'
    }
  }
}

watch(previewInput, () => {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(runPreview, 400)
}, { immediate: true })

onUnmounted(() => {
  if (previewTimer) clearTimeout(previewTimer)
})

const prettyBody = computed(() => {
  if (preview.value?.type !== 'webhook') return ''
  try {
    return JSON.stringify(JSON.parse(preview.value.request.body), null, 2)
  } catch {
    return preview.value.request.body
  }
})

const testing = ref(false)
const testResult = ref<{ ok: boolean; status?: number; error?: string } | null>(null)

const testLine = computed(() => {
  if (!testResult.value) return null
  if (testResult.value.ok) return { ok: true, text: testResult.value.status !== undefined ? `Sent (HTTP ${testResult.value.status})` : 'Sent' }
  return { ok: false, text: testResult.value.error ?? 'Test failed' }
})

async function sendTest() {
  if (!canSubmit.value || testing.value) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await trpc.notifications.testConnector.mutate(previewInput.value)
  } catch (e: any) {
    testResult.value = { ok: false, error: e?.message ?? 'Test failed' }
  } finally {
    testing.value = false
  }
}

async function save() {
  if (saving.value) return
  saving.value = true
  saveError.value = ''
  const payload = { ...part.value, name: name.value.trim(), enabled: enabled.value, rateLimitPerMinute: Number(rateLimit.value) || 10 }
  try {
    if (props.connector) await trpc.notifications.connectors.update.mutate({ id: props.connector.id, ...payload })
    else await trpc.notifications.connectors.create.mutate(payload)
    emit('saved')
  } catch (e: any) {
    saveError.value = e?.message ?? 'Failed to save connector'
  } finally {
    saving.value = false
  }
}

const bodyPlaceholder = '{ "message": "{{event.message}}" }'
const variableHint = 'Supports variables like {{event.source}}, {{event.severity}} and {{event.message}}.'
</script>

<template>
  <Modal panel-class="w-full max-w-xl" @close="emit('close')">
    <template #header>
      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">
        {{ connector ? 'Edit connector' : 'Add connector' }}
      </h3>
    </template>

    <div class="p-5 space-y-4">
      <p v-if="connector?.secretsUnreadable" class="text-xs text-[var(--c-danger)]">
        Saved secrets can no longer be read (the secrets key changed). Re-enter the URL, secret headers or password.
      </p>

      <div class="flex gap-2">
        <div class="space-y-1.5 w-40 shrink-0">
          <label class="block text-xs text-[var(--c-text-3)]">Type</label>
          <select v-if="!connector" v-model="type" class="ui-input">
            <option value="webhook">Webhook</option>
            <option value="smtp">Email (SMTP)</option>
          </select>
          <p v-else class="py-1.5"><span class="badge badge-muted">{{ type === 'smtp' ? 'email' : 'webhook' }}</span></p>
        </div>
        <div class="space-y-1.5 flex-1 min-w-0">
          <label class="block text-xs text-[var(--c-text-3)]">Format</label>
          <select v-model="format" class="ui-input">
            <option v-for="p in formatOptions" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
        </div>
      </div>
      <p class="text-xs text-[var(--c-text-3)] -mt-2">The format prefills the fields below; everything stays editable.</p>

      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Name</label>
        <input v-model="name" :placeholder="type === 'smtp' ? 'Admin email' : 'My Discord channel'" class="ui-input" />
      </div>

      <template v-if="type === 'webhook'">
        <div class="flex gap-2">
          <div class="space-y-1.5 w-24 shrink-0">
            <label class="block text-xs text-[var(--c-text-3)]">Method</label>
            <select v-model="method" class="ui-input">
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
            </select>
          </div>
          <div class="space-y-1.5 flex-1 min-w-0">
            <label class="block text-xs text-[var(--c-text-3)]">URL</label>
            <input v-model="url" placeholder="https://example.com/hook" class="ui-input font-mono" />
          </div>
        </div>
        <p v-if="connector" class="text-xs text-[var(--c-text-3)] -mt-2">The saved URL is hidden. Leave it unchanged to keep it.</p>

        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="block text-xs text-[var(--c-text-3)]">Headers</label>
            <button type="button" class="text-xs text-[var(--c-accent)] hover:opacity-80" @click="addHeaderRow">+ Add header</button>
          </div>
          <div v-for="(row, i) in headerRows" :key="i" class="flex items-center gap-1.5">
            <input v-model="row.key" placeholder="Key" class="ui-input flex-1 min-w-0 font-mono text-xs" />
            <input v-model="row.value" placeholder="Value" class="ui-input flex-[2] min-w-0 font-mono text-xs" />
            <button
              type="button" title="Remove header"
              class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors shrink-0"
              @click="removeHeaderRow(i)"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
          <p v-if="headerRows.length === 0" class="text-xs text-[var(--c-text-3)]">No headers.</p>
          <p v-else-if="connector" class="text-xs text-[var(--c-text-3)]">Header values other than Content-Type are hidden once saved. Leave them unchanged to keep them.</p>
        </div>

        <div class="space-y-1.5">
          <label class="block text-xs text-[var(--c-text-3)]">Body template</label>
          <textarea v-model="bodyTemplate" rows="7" :placeholder="bodyPlaceholder" class="ui-input font-mono text-xs resize-none" />
          <p class="text-xs text-[var(--c-text-3)]">{{ variableHint }}</p>
        </div>
      </template>

      <template v-else>
        <div class="flex gap-2">
          <div class="space-y-1.5 flex-1 min-w-0">
            <label class="block text-xs text-[var(--c-text-3)]">SMTP server</label>
            <input v-model="smtp.host" placeholder="smtp.example.com" class="ui-input font-mono" />
          </div>
          <div class="space-y-1.5 w-24 shrink-0">
            <label class="block text-xs text-[var(--c-text-3)]">Port</label>
            <input v-model.number="smtp.port" type="number" min="1" max="65535" class="ui-input" />
          </div>
          <div class="space-y-1.5 w-32 shrink-0">
            <label class="block text-xs text-[var(--c-text-3)]">Security</label>
            <select v-model="smtp.security" class="ui-input">
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">None</option>
            </select>
          </div>
        </div>

        <div class="flex gap-2">
          <div class="space-y-1.5 flex-1 min-w-0">
            <label class="block text-xs text-[var(--c-text-3)]">Username</label>
            <input v-model="smtp.username" autocomplete="off" placeholder="Optional" class="ui-input" />
          </div>
          <div class="space-y-1.5 flex-1 min-w-0">
            <label class="block text-xs text-[var(--c-text-3)]">Password</label>
            <input
              v-model="smtp.password" type="password" autocomplete="new-password"
              :placeholder="passwordSet ? 'Saved, leave empty to keep' : 'Optional'" class="ui-input"
            />
          </div>
        </div>

        <div class="space-y-1.5">
          <label class="block text-xs text-[var(--c-text-3)]">From</label>
          <input v-model="smtp.from" placeholder="nas@example.com" class="ui-input" />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs text-[var(--c-text-3)]">To</label>
          <input v-model="smtp.to" placeholder="admin@example.com, other@example.com" class="ui-input" />
          <p class="text-xs text-[var(--c-text-3)]">Separate addresses with commas.</p>
        </div>

        <div class="space-y-1.5">
          <label class="block text-xs text-[var(--c-text-3)]">Subject template</label>
          <input v-model="smtp.subjectTemplate" class="ui-input font-mono text-xs" />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs text-[var(--c-text-3)]">Body template</label>
          <textarea v-model="smtp.bodyTemplate" rows="7" class="ui-input font-mono text-xs resize-none" />
          <p class="text-xs text-[var(--c-text-3)]">{{ variableHint }}</p>
        </div>
      </template>

      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Max messages per minute</label>
        <input v-model.number="rateLimit" type="number" min="1" max="600" class="ui-input w-24" />
        <p class="text-xs text-[var(--c-text-3)]">Extra messages wait in the queue; none are dropped.</p>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Preview</label>
        <p v-if="previewError" class="text-xs text-[var(--c-danger)]">{{ previewError }}</p>
        <div v-else-if="preview?.type === 'webhook'" class="rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] p-3 font-mono text-xs text-[var(--c-text-2)] space-y-2">
          <p class="break-all"><span class="font-bold text-[var(--c-text-1)]">{{ preview.request.method }}</span> {{ preview.request.url }}</p>
          <div v-if="Object.keys(preview.request.headers).length > 0" class="space-y-0.5">
            <p v-for="(v, k) in preview.request.headers" :key="k" class="break-all">{{ k }}: {{ v }}</p>
          </div>
          <pre class="whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{{ prettyBody }}</pre>
        </div>
        <div v-else-if="preview?.type === 'smtp'" class="rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] p-3 font-mono text-xs text-[var(--c-text-2)] space-y-2">
          <div class="space-y-0.5">
            <p class="break-all"><span class="text-[var(--c-text-3)]">From:</span> {{ preview.email.from }}</p>
            <p class="break-all"><span class="text-[var(--c-text-3)]">To:</span> {{ preview.email.to.join(', ') }}</p>
            <p class="break-all"><span class="text-[var(--c-text-3)]">Subject:</span> <span class="text-[var(--c-text-1)]">{{ preview.email.subject }}</span></p>
          </div>
          <pre class="whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{{ preview.email.text }}</pre>
        </div>
        <p v-else class="text-xs text-[var(--c-text-3)]">
          {{ type === 'smtp' ? 'Enter a server, a sender and a recipient to preview the email.' : 'Enter a URL to preview the rendered request.' }}
        </p>
      </div>

      <label class="flex items-center gap-2 text-sm text-[var(--c-text-2)] cursor-pointer">
        <input v-model="enabled" type="checkbox" />
        Enabled
      </label>

      <p v-if="saveError" class="text-xs text-[var(--c-danger)]">{{ saveError }}</p>
    </div>

    <template #footer>
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <button type="button" class="btn btn-outline btn-sm shrink-0" :disabled="!canSubmit || testing" @click="sendTest">
          {{ testing ? 'Sending…' : 'Send test' }}
        </button>
        <span
          v-if="testLine"
          :class="['text-xs truncate', testLine.ok ? 'text-[var(--c-success)]' : 'text-[var(--c-danger)]']"
        >{{ testLine.text }}</span>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" @click="emit('close')">Cancel</button>
      <button
        type="button" class="btn btn-primary btn-sm"
        :disabled="saving || !name.trim() || !canSubmit"
        @click="save"
      >
        {{ saving ? 'Saving…' : 'Save' }}
      </button>
    </template>
  </Modal>
</template>
