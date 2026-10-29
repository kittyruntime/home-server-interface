<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, watch } from 'vue'
import Modal from './ui/Modal.vue'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'
import EmptyState from './ui/EmptyState.vue'
import { trpc } from '../lib/trpc'
import { jobLogsTarget } from '../lib/jobLogs'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

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
  if (level === 'error' || level === 'fatal') return 'text-destructive'
  if (level === 'warn') return 'text-warning'
  return 'text-muted-foreground'
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
        <h3 class="text-sm font-semibold text-foreground">{{ t('ui.settings.JobLogsDialog.operationLogs') }}</h3>
        <p class="text-2xs font-mono text-muted-foreground truncate">{{ jobLogsTarget }}</p>
      </div>
    </template>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" compact />
    <EmptyState
      v-else-if="lines.length === 0"
      :message="t('ui.settings.JobLogsDialog.noLogLinesForThis')"
      :description="t('ui.settings.JobLogsDialog.theyMayHaveBeenRotated')"
    />
    <ol v-else class="divide-y divide-border font-mono text-2xs leading-relaxed">
      <li v-for="(l, i) in lines" :key="i" class="px-5 py-2">
        <div class="flex items-baseline gap-2">
          <span class="shrink-0 tabular-nums text-muted-foreground">{{ formatTime(l.time) }}</span>
          <span class="shrink-0 w-12 uppercase" :class="levelClass(l.level)">{{ l.level }}</span>
          <span class="shrink-0 w-14 text-muted-foreground">{{ l.source }}</span>
          <span class="text-foreground break-words min-w-0">{{ l.msg }}</span>
        </div>
        <dl v-if="Object.keys(l.fields).length" class="mt-0.5 sm:pl-[8.5rem] grid grid-cols-[auto_1fr] gap-x-2 text-foreground/80">
          <template v-for="(v, k) in l.fields" :key="k">
            <dt class="text-muted-foreground">{{ k }}</dt>
            <dd class="whitespace-pre-wrap break-all">{{ formatValue(v) }}</dd>
          </template>
        </dl>
      </li>
    </ol>

    <template #footer>
      <p class="text-2xs text-muted-foreground">{{ t('ui.settings.JobLogsDialog.fromAppLogAndRoot') }}</p>
      <div class="flex-1" />
      <Button variant="ghost" size="sm" v-if="lines.length" @click="copyAll">{{ t('ui.settings.JobLogsDialog.copy') }}</Button>
      <Button size="sm" @click="modal?.requestClose()">{{ t('ui.settings.JobLogsDialog.close') }}</Button>
    </template>
  </Modal>
</template>
