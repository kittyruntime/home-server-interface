<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BotIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import Modal from './ui/Modal.vue'
import BusyLabel from './ui/BusyLabel.vue'
import { trpc } from '../lib/trpc'
import { useToast } from '../lib/toast'
import { formatDateTime } from '../lib/format-date'

// Changes an AI assistant asked for over MCP (#138), waiting for this
// account's approval. Nothing runs until Approve: then exactly the request is
// run, as this account, and recorded in the audit log as the assistant's.

const { t } = useI18n()
const toast = useToast()

type Lists = Awaited<ReturnType<typeof trpc.agentAction.list.query>>
type Request = Lists['pending'][number]
type Step = { summary?: string; destructive?: boolean; kind?: string; target?: string; command?: string[]; diff?: string }

const POLL_MS = 15_000

const pending = ref<Request[]>([])
const open = ref(false)
const modal = ref<InstanceType<typeof Modal> | null>(null)
const busy = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

async function refresh() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  try {
    pending.value = (await trpc.agentAction.list.query()).pending
    if (!pending.value.length) open.value = false
  } catch { /* the next poll tries again */ }
}

function steps(r: Request): Step[] {
  const p = r.preview as { steps?: Step[] } | null
  return Array.isArray(p?.steps) ? p.steps : []
}

// A request without a plan (files to delete, a file to replace, an access, an
// update) shows its own details.
function details(r: Request): string | null {
  const p = r.preview as Record<string, unknown> | null
  if (!p || Array.isArray(p.steps)) return null
  if (Array.isArray(p.delete)) {
    return (p.delete as Array<{ path: string; type?: string }>).map(i => i.type === 'dir' ? `${i.path}/` : i.path).join('\n')
  }
  return JSON.stringify(p, null, 2)
}

async function decide(r: Request, approve: boolean) {
  busy.value = r.id
  try {
    if (approve) {
      const done = await trpc.agentAction.approve.mutate({ id: r.id })
      if (done.status === 'done') toast.success(t('agentRequests.done', { title: r.title }))
      else toast.error(t('agentRequests.failed', { title: r.title, error: done.error ?? '' }))
    } else {
      await trpc.agentAction.reject.mutate({ id: r.id })
    }
  } catch (e: any) {
    toast.error(e?.message ?? t('agentRequests.decideFailed'))
  } finally {
    busy.value = null
    await refresh()
  }
}

const first = computed(() => pending.value[0])

function onVisible() { if (document.visibilityState === 'visible') void refresh() }

onMounted(() => {
  void refresh()
  timer = setInterval(refresh, POLL_MS)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <!-- The prompt: always visible while something waits. -->
  <div
    v-if="first && !open"
    role="status"
    class="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-violet/40 bg-card p-3 shadow-lg"
  >
    <div class="flex items-start gap-2.5">
      <BotIcon class="mt-0.5 size-4 shrink-0 text-violet" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-foreground">{{ t('agentRequests.prompt', pending.length) }}</p>
        <p class="truncate text-xs text-muted-foreground" :title="first.title">{{ first.title }}</p>
      </div>
    </div>
    <Button size="sm" class="mt-2.5 w-full" @click="open = true">{{ t('agentRequests.review') }}</Button>
  </div>

  <Modal v-if="open" ref="modal" panel-class="w-full max-w-2xl" :prevent-close="busy !== null" @close="open = false">
    <template #header>
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-foreground">{{ t('agentRequests.title') }}</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('agentRequests.subtitle') }}</p>
      </div>
    </template>

    <div class="space-y-4 px-5 py-4">
      <p v-if="!pending.length" class="text-sm text-muted-foreground">{{ t('agentRequests.none') }}</p>
      <section
        v-for="r in pending" :key="r.id"
        class="rounded-lg border px-4 py-3"
        :class="r.destructive ? 'border-destructive/40' : 'border-border'"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-medium text-foreground break-words">{{ r.title }}</p>
            <p class="mt-0.5 text-2xs text-muted-foreground">
              {{ r.tokenName ?? t('agentRequests.unknownToken') }} · {{ formatDateTime(r.createdAt) }}
            </p>
          </div>
          <span v-if="r.destructive" class="shrink-0 text-xs font-medium text-destructive">{{ t('agentRequests.destructive') }}</span>
        </div>
        <p v-if="r.reason" class="mt-2 text-xs text-foreground/80">
          <span class="text-muted-foreground">{{ t('agentRequests.reason') }}</span> {{ r.reason }}
        </p>

        <ol v-if="steps(r).length" class="mt-3 divide-y divide-border rounded-md border border-border">
          <li v-for="(s, i) in steps(r)" :key="i" class="px-3 py-2">
            <p class="text-xs" :class="s.destructive ? 'text-destructive' : 'text-foreground'">{{ i + 1 }}. {{ s.summary }}</p>
            <p v-if="s.target" class="mt-0.5 font-mono text-2xs text-muted-foreground">{{ s.target }}</p>
            <details v-if="s.command?.length || s.diff" class="mt-1">
              <summary class="cursor-pointer text-2xs text-muted-foreground hover:text-foreground">{{ t('agentRequests.exactChange') }}</summary>
              <pre class="mt-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-2xs text-foreground">{{ s.command?.join(' ') ?? s.diff }}</pre>
            </details>
          </li>
        </ol>
        <pre v-else-if="details(r)" class="mt-3 max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-2xs text-foreground whitespace-pre-wrap break-all">{{ details(r) }}</pre>

        <div class="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" :disabled="busy !== null" @click="decide(r, false)">{{ t('agentRequests.reject') }}</Button>
          <Button size="sm" :variant="r.destructive ? 'destructive' : 'default'" :disabled="busy !== null" @click="decide(r, true)">
            <BusyLabel :busy="busy === r.id" :busy-label="t('agentRequests.running')">{{ t('agentRequests.approve') }}</BusyLabel>
          </Button>
        </div>
      </section>
    </div>

    <template #footer>
      <div class="flex-1" />
      <Button size="sm" variant="ghost" :disabled="busy !== null" @click="modal?.requestClose()">{{ t('agentRequests.later') }}</Button>
    </template>
  </Modal>
</template>
