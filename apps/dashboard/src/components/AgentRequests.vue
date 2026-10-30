<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BotIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import Modal from './ui/Modal.vue'
import AgentRequestCard from './assistant/AgentRequestCard.vue'
import { trpc } from '../lib/trpc'
import { useToast } from '../lib/toast'
import { AGENT_DECIDED_EVENT } from '../lib/assistant'

// Changes an AI assistant asked for, over MCP (#138) or in the built-in chat,
// waiting for this account's approval. Nothing runs until Approve: then exactly the request is
// run, as this account, and recorded in the audit log as the assistant's.

const { t } = useI18n()
const toast = useToast()

type Lists = Awaited<ReturnType<typeof trpc.agentAction.list.query>>
type Request = Lists['pending'][number]

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
    // The built-in assistant's chat goes on with the decision.
    if (r.conversationId) window.dispatchEvent(new CustomEvent(AGENT_DECIDED_EVENT, { detail: { conversationId: r.conversationId } }))
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
      <AgentRequestCard
        v-for="r in pending" :key="r.id"
        :request="r" :busy="busy === r.id" :disabled="busy !== null" source
        @decide="approve => decide(r, approve)"
      />
    </div>

    <template #footer>
      <div class="flex-1" />
      <Button size="sm" variant="ghost" :disabled="busy !== null" @click="modal?.requestClose()">{{ t('agentRequests.later') }}</Button>
    </template>
  </Modal>
</template>
