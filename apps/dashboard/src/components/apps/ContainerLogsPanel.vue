<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useAuth } from '../../lib/auth'

const props = defineProps<{ name: string }>()
const emit  = defineEmits<{ close: [] }>()

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
    if (e.name !== 'AbortError') error.value = e.message ?? 'Connection failed'
    return
  }

  if (!res.ok) {
    error.value = `Error ${res.status}: ${await res.text()}`
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
    if (e.name !== 'AbortError') error.value = e.message ?? 'Stream error'
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
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm" @click.self="emit('close')">
      <div class="flex flex-col m-4 sm:m-8 flex-1 min-h-0 bg-[#0d1117] border border-[var(--c-border-strong)] rounded-2xl overflow-hidden shadow-2xl">

        <!-- Header -->
        <div class="flex items-center gap-3 px-4 py-3 border-b border-[#30363d] bg-[#161b22] flex-shrink-0">
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <!-- Status dot -->
            <span :class="['w-2 h-2 rounded-full shrink-0', connected ? 'bg-green-400 animate-pulse' : 'bg-[var(--c-text-3)]']" />
            <span class="font-mono text-sm font-semibold text-[#e6edf3]">{{ name }}</span>
            <span class="text-[11px] text-[#7d8590] ml-1">{{ connected ? 'streaming' : 'disconnected' }}</span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <!-- Follow toggle -->
            <button
              @click="toggleFollow"
              :title="follow ? 'Auto-scroll on' : 'Auto-scroll off'"
              :class="['flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md border transition-colors',
                follow
                  ? 'bg-[var(--c-accent)]/20 border-[var(--c-accent)]/50 text-[var(--c-accent)]'
                  : 'border-[#30363d] text-[#7d8590] hover:border-[#484f58]']"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3"/>
              </svg>
              Follow
            </button>
            <!-- Clear -->
            <button
              @click="clear"
              title="Clear"
              class="flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-[#30363d] text-[#7d8590] rounded-md hover:border-[#484f58] hover:text-[#e6edf3] transition-colors"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
              Clear
            </button>
            <!-- Close -->
            <button
              @click="emit('close')"
              title="Close"
              class="w-7 h-7 flex items-center justify-center rounded-md text-[#7d8590] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- Log area -->
        <div
          ref="logEl"
          @scroll="onScroll"
          class="flex-1 overflow-y-auto font-mono text-[12px] leading-relaxed p-4 select-text"
          style="color: #e6edf3"
        >
          <!-- Error -->
          <div v-if="error" class="text-red-400 mb-2">{{ error }}</div>

          <!-- Empty -->
          <div v-if="lines.length === 0 && !error && connected"
            class="text-[#7d8590] italic">Waiting for logs…</div>

          <!-- Lines -->
          <div
            v-for="(line, i) in lines"
            :key="i"
            class="flex gap-3 hover:bg-white/5 px-1 rounded leading-6"
          >
            <span v-if="line.ts" class="text-[#484f58] shrink-0 tabular-nums select-none">{{ line.ts }}</span>
            <span class="break-all whitespace-pre-wrap min-w-0">{{ line.text }}</span>
          </div>

          <!-- Reconnect hint when not connected -->
          <div v-if="!connected && !error && lines.length > 0" class="text-[#484f58] mt-2 italic">
            — stream ended —
          </div>
        </div>

        <!-- Bottom status bar -->
        <div class="flex items-center justify-between px-4 py-1.5 border-t border-[#30363d] bg-[#161b22] flex-shrink-0">
          <span class="text-[11px] text-[#484f58] tabular-nums">{{ lines.length }} lines</span>
          <span v-if="!follow" class="text-[11px] text-[#7d8590]">
            Scroll to bottom to resume auto-scroll
          </span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
