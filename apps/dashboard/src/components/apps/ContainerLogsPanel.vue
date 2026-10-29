<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import Modal from '../ui/Modal.vue'
import { DialogTitle } from 'reka-ui'
import { ArrowDownIcon, XIcon } from '@lucide/vue'
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useAuth } from '../../lib/auth'

const { t } = useI18n()

const props = defineProps<{ name: string }>()
const emit  = defineEmits<{ close: [] }>()

// Closing goes through the dialog so it plays its leave animation, then
// reports `close` like every other dialog.
const modal = ref<InstanceType<typeof Modal> | null>(null)
function close() { modal.value?.requestClose() }

const { token } = useAuth()

interface LogLine { ts: string; text: string; stream?: 'stdout' | 'stderr' }

const lines      = ref<LogLine[]>([])
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
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    return { ts, text: m[2]! }
  }
  return { ts: '', text: raw }
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
    lines.value.push(...batch)
    batch.length = 0
    if (lines.value.length > 2000) lines.value = lines.value.slice(-2000)
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
    :show-close="false"
    panel-class="w-full max-w-none h-[calc(100dvh-1rem)] max-h-none sm:h-[calc(100dvh-4rem)] sm:max-h-none sm:mx-4 overflow-hidden border-input bg-[#0d1117]"
    @close="emit('close')"
  >
    <div class="flex h-full flex-col min-h-0">

      <!-- Header -->
      <div class="flex items-center gap-3 px-4 py-3 border-b border-[#30363d] bg-[#161b22] flex-shrink-0">
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <!-- Status dot -->
          <span :class="['w-2 h-2 rounded-full shrink-0', connected ? 'bg-success animate-pulse' : 'bg-muted-foreground']" />
          <DialogTitle as="span" class="font-mono text-sm font-semibold text-[#e6edf3]">{{ name }}</DialogTitle>
          <span class="text-2xs text-[#7d8590] ml-1">{{ connected ? 'streaming' : 'disconnected' }}</span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <!-- Follow toggle -->
          <Button
            variant="outline" size="xs"
            @click="toggleFollow"
            :tooltip="follow ? 'Auto-scroll on' : 'Auto-scroll off'"
            :aria-pressed="follow"
            :class="['bg-transparent text-2xs dark:bg-transparent',
              follow
                ? 'bg-primary/20 border-primary/50 text-primary hover:bg-primary/25 hover:text-primary dark:bg-primary/20'
                : 'border-[#30363d] text-[#7d8590] hover:border-[#484f58] hover:bg-[#21262d] hover:text-[#e6edf3] dark:border-[#30363d]']"
          >
            <ArrowDownIcon class="size-3" aria-hidden="true" />
            {{ t('ui.apps.ContainerLogsPanel.follow') }}
          </Button>
          <!-- Clear -->
          <Button
            variant="outline" size="xs"
            @click="clear"
            :tooltip="t('ui.apps.ContainerLogsPanel.clear')"
            class="bg-transparent text-2xs border-[#30363d] text-[#7d8590] hover:border-[#484f58] hover:bg-[#21262d] hover:text-[#e6edf3] dark:bg-transparent dark:border-[#30363d]"
          >
            <XIcon class="size-3" aria-hidden="true" />
            {{ t('ui.apps.ContainerLogsPanel.clear') }}
          </Button>
          <!-- Close -->
          <Button variant="ghost" size="icon-sm"
            @click="close"
            :tooltip="t('ui.apps.ContainerLogsPanel.close')" :aria-label="t('ui.apps.ContainerLogsPanel.close')"
            class="text-[#7d8590] hover:text-[#e6edf3] hover:bg-[#21262d]"
          >
            <XIcon class="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <!-- Log area -->
      <div
        ref="logEl"
        @scroll="onScroll"
        class="flex-1 overflow-y-auto font-mono text-xs leading-relaxed p-4 select-text"
        style="color: #e6edf3"
      >
        <!-- Error -->
        <p v-if="error" role="alert" class="mb-2 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>

        <!-- Empty -->
        <div v-if="lines.length === 0 && !error && connected"
          class="text-[#7d8590] italic">{{ t('ui.apps.ContainerLogsPanel.waitingForLogs') }}</div>

        <!-- Lines -->
        <div
          v-for="(line, i) in lines"
          :key="i"
          class="flex gap-3 hover:bg-white/5 px-1 rounded-sm leading-6"
        >
          <span v-if="line.ts" class="text-[#484f58] shrink-0 tabular-nums select-none">{{ line.ts }}</span>
          <span class="break-all whitespace-pre-wrap min-w-0">{{ line.text }}</span>
        </div>

        <!-- Reconnect hint when not connected -->
        <div v-if="!connected && !error && lines.length > 0" class="text-[#484f58] mt-2 italic">
          [stream ended]
        </div>
      </div>

      <!-- Bottom status bar -->
      <div class="flex items-center justify-between px-4 py-1.5 border-t border-[#30363d] bg-[#161b22] flex-shrink-0">
        <span class="text-2xs text-[#484f58] tabular-nums">{{ lines.length }} lines</span>
        <span v-if="!follow" class="text-2xs text-[#7d8590]">
          {{ t('ui.apps.ContainerLogsPanel.scrollToBottomToResume') }}
        </span>
      </div>
    </div>
  </Modal>
</template>
