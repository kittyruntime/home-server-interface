<script setup lang="ts">
import { ref, watch } from 'vue'
import Modal from './ui/Modal.vue'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'
import EmptyState from './ui/EmptyState.vue'
import { trpc } from '../lib/trpc'
import { jobLogsTarget } from '../lib/jobLogs'

type LogLine = Awaited<ReturnType<typeof trpc.tasks.logs.query>>[number]

const modal = ref<InstanceType<typeof Modal> | null>(null)
const lines = ref<LogLine[]>([])
const loading = ref(false)
const error = ref('')

async function load(jobId: string) {
  loading.value = true
  error.value = ''
  try {
    lines.value = await trpc.tasks.logs.query({ jobId })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(jobLogsTarget, id => { if (id) void load(id) }, { immediate: true })

function formatTime(t: string | null): string {
  if (!t) return ''
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? t : d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

function formatValue(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function levelClass(level: string): string {
  if (level === 'error' || level === 'fatal') return 'text-danger'
  if (level === 'warn') return 'text-warning'
  return 'text-[var(--c-text-3)]'
}

async function copyAll() {
  const text = lines.value.map(l => JSON.stringify(l)).join('\n')
  await navigator.clipboard?.writeText(text)
}
</script>

<template>
  <Modal v-if="jobLogsTarget" ref="modal" :key="jobLogsTarget" panel-class="w-full max-w-3xl" @close="jobLogsTarget = null">
    <template #header>
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-[var(--c-text-1)]">Operation logs</h3>
        <p class="text-[11px] font-mono text-[var(--c-text-3)] truncate">{{ jobLogsTarget }}</p>
      </div>
    </template>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" compact />
    <EmptyState
      v-else-if="lines.length === 0"
      message="No log lines for this operation"
      description="They may have been rotated away. Set HSI_LOG_LEVEL=debug for more detail."
    />
    <ol v-else class="divide-y divide-[var(--c-border)] font-mono text-[11px] leading-relaxed">
      <li v-for="(l, i) in lines" :key="i" class="px-5 py-2">
        <div class="flex items-baseline gap-2">
          <span class="shrink-0 tabular-nums text-[var(--c-text-3)]">{{ formatTime(l.time) }}</span>
          <span class="shrink-0 w-12 uppercase" :class="levelClass(l.level)">{{ l.level }}</span>
          <span class="shrink-0 w-14 text-[var(--c-text-3)]">{{ l.source }}</span>
          <span class="text-[var(--c-text-1)] break-words min-w-0">{{ l.msg }}</span>
        </div>
        <dl v-if="Object.keys(l.fields).length" class="mt-0.5 sm:pl-[8.5rem] grid grid-cols-[auto_1fr] gap-x-2 text-[var(--c-text-2)]">
          <template v-for="(v, k) in l.fields" :key="k">
            <dt class="text-[var(--c-text-3)]">{{ k }}</dt>
            <dd class="whitespace-pre-wrap break-all">{{ formatValue(v) }}</dd>
          </template>
        </dl>
      </li>
    </ol>

    <template #footer>
      <p class="text-[11px] text-[var(--c-text-3)]">From app.log and root-worker.log</p>
      <div class="flex-1" />
      <button v-if="lines.length" @click="copyAll" class="btn btn-ghost btn-sm">Copy</button>
      <button @click="modal?.requestClose()" class="btn btn-primary btn-sm">Close</button>
    </template>
  </Modal>
</template>
