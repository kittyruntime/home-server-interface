<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import Modal from '../ui/Modal.vue'
import { ArrowDownToLineIcon, EraserIcon, TriangleAlertIcon } from '@lucide/vue'
import { ref, shallowRef, onMounted, onUnmounted, nextTick } from 'vue'
import { useAuth } from '../../lib/auth'
import { dateFormat } from '../../lib/intl-cache'

const { t } = useI18n()

const props = defineProps<{ name: string }>()
const emit  = defineEmits<{ close: [] }>()

// Closing goes through the dialog so it plays its leave animation, then
// reports `close` like every other dialog.
const modal = ref<InstanceType<typeof Modal> | null>(null)
function close() { modal.value?.requestClose() }

const { token } = useAuth()

interface LogLine { id: number; ts: string; text: string; tone: '' | 'text-error' | 'text-warning' }

// Most images tag their lines with a level: errors and warnings stand out the
// way they do in the operation logs.
const ERROR_RE = /\b(ERR|ERROR|FATAL|CRIT|CRITICAL|PANIC)\b/i
const WARN_RE = /\b(WRN|WARN|WARNING)\b/i
const toneOf = (text: string): LogLine['tone'] => ERROR_RE.test(text) ? 'text-error' : WARN_RE.test(text) ? 'text-warning' : ''

// Replaced on each flush (never edited in place), and keyed by a running id so
// trimming the head of the buffer does not re-render every line.
const lines      = shallowRef<LogLine[]>([])
let nextId = 0
const logEl      = ref<HTMLElement | null>(null)
const follow     = ref(true)
const connected  = ref(false)
const error      = ref('')

const BASE_URL = import.meta.env.VITE_API_URL
  ? (import.meta.env.VITE_API_URL as string).replace(/\/trpc$/, '')
  : ''

let controller: AbortController | null = null

function scrollToBottom() {
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
}

function parseLine(raw: string): LogLine {
  // Docker --timestamps format: "2024-01-15T12:34:56.123456789Z  the log text"
  // The timestamp may be separated by one space (stdout) or have stderr marker
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/)
  if (m) {
    const d = new Date(m[1]!)
    const ts = isNaN(d.getTime())
      ? m[1]!
      : dateFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d)
    return { id: nextId++, ts, text: m[2]!, tone: toneOf(m[2]!) }
  }
  return { id: nextId++, ts: '', text: raw, tone: toneOf(raw) }
}

async function startStream() {
  error.value = ''
  lines.value = []
  controller  = new AbortController()

  let res: Response
  try {
    res = await fetch(`${BASE_URL}/containers/${encodeURIComponent(props.name)}/logs`, {
      headers: { Authorization: `Bearer ${token.value}` },
      signal: controller.signal,
    })
  } catch (e: any) {
    if (e.name !== 'AbortError') error.value = e.message ?? t('uis.apps.ContainerLogsPanel.connectionFailed')
    return
  }

  if (!res.ok) {
    error.value = t('uis.apps.ContainerLogsPanel.error', { p0: res.status, p1: await res.text() })
    return
  }

  connected.value = true
  const reader = res.body!.getReader()
  const dec    = new TextDecoder()
  let   buf    = ''

  const batch: LogLine[] = []
  let   flushTimer: ReturnType<typeof setTimeout> | null = null

  function flush() {
    flushTimer = null
    if (!batch.length) return
    lines.value = lines.value.concat(batch).slice(-2000)
    batch.length = 0
    if (follow.value) nextTick(scrollToBottom)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const json = line.slice(6)
          try {
            const obj = JSON.parse(json) as { line?: string; done?: boolean; error?: string }
            if (obj.done) {
              connected.value = false
              flush()
              return
            }
            if (obj.error) {
              error.value = obj.error
              flush()
              return
            }
            if (obj.line != null) {
              batch.push(parseLine(obj.line))
              if (!flushTimer) flushTimer = setTimeout(flush, 60)
            }
          } catch {}
        }
      }
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') error.value = e.message ?? t('uis.apps.ContainerLogsPanel.streamError')
  } finally {
    if (flushTimer) clearTimeout(flushTimer)
    flush()
    connected.value = false
  }
}

function clear() { lines.value = [] }

function onScroll() {
  if (!logEl.value) return
  const el = logEl.value
  follow.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
}

function toggleFollow() {
  follow.value = !follow.value
  if (follow.value) scrollToBottom()
}

onMounted(() => startStream())
onUnmounted(() => controller?.abort())
</script>

<template>
  <Modal
    ref="modal"
    panel-class="w-full sm:max-w-5xl h-[calc(100dvh-1rem)] sm:h-[min(85dvh,56rem)]"
    @close="emit('close')"
  >
    <template #header>
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-base-content">{{ t('ui.apps.ContainerLogsPanel.title') }}</h3>
        <p class="text-2xs font-mono text-base-content/70 truncate">{{ name }}</p>
      </div>
      <span
        :class="['inline-flex shrink-0 items-center gap-1.5 text-2xs', connected ? 'text-success' : 'text-base-content/70']"
        role="status"
      >
        <span :class="['size-1.5 rounded-full', connected ? 'bg-success animate-pulse' : 'bg-base-content/40']" aria-hidden="true" />
        {{ connected ? t('ui.apps.ContainerLogsPanel.live') : t('ui.apps.ContainerLogsPanel.ended') }}
      </span>
    </template>

    <div
      ref="logEl"
      class="h-full overflow-y-auto bg-base-200 px-3 py-2 font-mono text-2xs leading-5 select-text sm:px-5"
      @scroll="onScroll"
    >
      <Alert v-if="error" variant="destructive" class="mb-2 font-sans"><TriangleAlertIcon /><AlertDescription>{{ error }}</AlertDescription></Alert>

      <p v-if="lines.length === 0 && !error && connected" class="py-6 text-center font-sans text-xs text-base-content/70">
        {{ t('ui.apps.ContainerLogsPanel.waitingForLogs') }}
      </p>

      <div
        v-for="line in lines"
        :key="line.id"
        class="-mx-1.5 flex gap-3 rounded-sm px-1.5 hover:bg-base-300/60"
      >
        <span v-if="line.ts" class="shrink-0 tabular-nums text-base-content/50 select-none">{{ line.ts }}</span>
        <span :class="['min-w-0 whitespace-pre-wrap break-all', line.tone || 'text-base-content']">{{ line.text }}</span>
      </div>

      <p v-if="!connected && !error && lines.length > 0" class="mt-3 border-t border-base-300 pt-2 font-sans text-2xs text-base-content/70">
        {{ t('ui.apps.ContainerLogsPanel.streamEnded') }}
      </p>
    </div>

    <template #footer>
      <p class="text-2xs tabular-nums text-base-content/70">
        {{ t('ui.apps.ContainerLogsPanel.lineCount', { n: lines.length }, lines.length) }}
        <span v-if="!follow" class="hidden sm:inline"> · {{ t('ui.apps.ContainerLogsPanel.scrollToBottomToResume') }}</span>
      </p>
      <div class="flex-1" />
      <Button
        variant="ghost" size="sm"
        :aria-pressed="follow"
        :tooltip="follow ? t('ui.apps.ContainerLogsPanel.followOn') : t('ui.apps.ContainerLogsPanel.followOff')"
        :class="follow ? 'text-primary' : ''"
        @click="toggleFollow"
      >
        <ArrowDownToLineIcon aria-hidden="true" />
        {{ t('ui.apps.ContainerLogsPanel.follow') }}
      </Button>
      <Button variant="ghost" size="sm" :disabled="lines.length === 0" @click="clear">
        <EraserIcon aria-hidden="true" />
        {{ t('ui.apps.ContainerLogsPanel.clear') }}
      </Button>
      <Button size="sm" @click="close">{{ t('ui.apps.ContainerLogsPanel.close') }}</Button>
    </template>
  </Modal>
</template>
