<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import Modal from '../ui/Modal.vue'

const props = defineProps<{ connector: null | { id: string; name: string; method: string; url: string; headers: string; bodyTemplate: string; enabled: boolean } }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const presets = ref<Awaited<ReturnType<typeof trpc.notifications.connectors.presets.query>>>([])
const format = ref('custom')
const name = ref('')
const method = ref('POST')
const url = ref('')
const bodyTemplate = ref('')
const enabled = ref(true)
const headerRows = ref<Array<{ key: string; value: string }>>([])

const saving = ref(false)
const saveError = ref('')

function headersToRows(json: string) {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    return Object.entries(parsed).map(([k, v]) => ({ key: k, value: String(v ?? '') }))
  } catch { return [] }
}

function applyPreset(p: (typeof presets.value)[number]) {
  method.value = p.method
  url.value = p.url
  bodyTemplate.value = p.bodyTemplate
  headerRows.value = headersToRows(p.headers)
}

name.value = props.connector?.name ?? ''
method.value = props.connector?.method ?? 'POST'
url.value = props.connector?.url ?? ''
bodyTemplate.value = props.connector?.bodyTemplate ?? ''
enabled.value = props.connector?.enabled ?? true
headerRows.value = headersToRows(props.connector?.headers ?? '{}')

function addHeaderRow() { headerRows.value.push({ key: '', value: '' }) }
function removeHeaderRow(i: number) { headerRows.value.splice(i, 1) }

const headersJson = computed(() =>
  JSON.stringify(Object.fromEntries(headerRows.value.map(r => [r.key, r.value]).filter(([k]) => k)))
)

watch(format, id => {
  const p = presets.value.find(x => x.id === id)
  if (p) applyPreset(p)
})

onMounted(async () => {
  try {
    presets.value = await trpc.notifications.connectors.presets.query()
  } catch {
    presets.value = []
  }
  if (!props.connector) {
    const custom = presets.value.find(p => p.id === 'custom')
    if (custom) applyPreset(custom)
  }
})

const previewInput = computed(() => ({
  method: method.value as 'POST' | 'PUT',
  url: url.value,
  headers: headersJson.value,
  bodyTemplate: bodyTemplate.value,
}))

const preview = ref<Awaited<ReturnType<typeof trpc.notifications.renderPreview.query>> | null>(null)
const previewError = ref('')

let previewTimer: ReturnType<typeof setTimeout> | null = null
let previewSeq = 0

async function runPreview() {
  if (!url.value.trim()) {
    preview.value = null
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
  if (!preview.value) return ''
  try {
    return JSON.stringify(JSON.parse(preview.value.body), null, 2)
  } catch {
    return preview.value.body
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
  if (!url.value.trim() || testing.value) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await trpc.notifications.testConnector.mutate({
      id: props.connector?.id,
      method: method.value as 'POST' | 'PUT',
      url: url.value,
      headers: headersJson.value,
      bodyTemplate: bodyTemplate.value,
    })
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
  const payload = {
    name: name.value.trim(),
    type: 'webhook' as const,
    method: method.value as 'POST' | 'PUT',
    url: url.value,
    headers: headersJson.value,
    bodyTemplate: bodyTemplate.value,
    enabled: enabled.value,
  }
  try {
    if (props.connector) {
      await trpc.notifications.connectors.update.mutate({ id: props.connector.id, ...payload })
    } else {
      await trpc.notifications.connectors.create.mutate(payload)
    }
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
      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Format</label>
        <select v-model="format" class="ui-input">
          <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <p class="text-xs text-[var(--c-text-3)]">Prefills the fields below; everything stays editable.</p>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Name</label>
        <input v-model="name" placeholder="My Discord channel" class="ui-input" />
      </div>

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
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Body template</label>
        <textarea v-model="bodyTemplate" rows="7" :placeholder="bodyPlaceholder" class="ui-input font-mono text-xs resize-none" />
        <p class="text-xs text-[var(--c-text-3)]">{{ variableHint }}</p>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs text-[var(--c-text-3)]">Preview</label>
        <p v-if="previewError" class="text-xs text-[var(--c-danger)]">{{ previewError }}</p>
        <div v-else-if="preview" class="rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] p-3 font-mono text-xs text-[var(--c-text-2)] space-y-2">
          <p class="break-all"><span class="font-bold text-[var(--c-text-1)]">{{ preview.method }}</span> {{ preview.url }}</p>
          <div v-if="Object.keys(preview.headers).length > 0" class="space-y-0.5">
            <p v-for="(v, k) in preview.headers" :key="k" class="break-all">{{ k }}: {{ v }}</p>
          </div>
          <pre class="whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{{ prettyBody }}</pre>
        </div>
        <p v-else class="text-xs text-[var(--c-text-3)]">Enter a URL to preview the rendered request.</p>
      </div>

      <label class="flex items-center gap-2 text-sm text-[var(--c-text-2)] cursor-pointer">
        <input v-model="enabled" type="checkbox" />
        Enabled
      </label>

      <p v-if="saveError" class="text-xs text-[var(--c-danger)]">{{ saveError }}</p>
    </div>

    <template #footer>
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <button type="button" class="btn btn-outline btn-sm shrink-0" :disabled="!url.trim() || testing" @click="sendTest">
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
        :disabled="saving || !name.trim() || !url.trim()"
        @click="save"
      >
        {{ saving ? 'Saving…' : 'Save' }}
      </button>
    </template>
  </Modal>
</template>
