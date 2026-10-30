<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ArrowUpIcon, BotIcon, CheckIcon, CircleAlertIcon, LoaderCircleIcon, MenuIcon, PlusIcon, SettingsIcon, SquareIcon, Trash2Icon, WrenchIcon, XIcon,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import LoadingState from '../ui/LoadingState.vue'
import EmptyState from '../ui/EmptyState.vue'
import AgentRequestCard, { type AgentRequest } from './AgentRequestCard.vue'
import AssistantSettingsCard from './AssistantSettingsCard.vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { useConfirm } from '../../lib/confirm'
import { renderMarkdown } from '../../lib/markdown'
import { AGENT_DECIDED_EVENT, assistantAvailable, ChatHttpError, refreshAssistantStatus, streamChat, type ChatEvent, type ChatRequest } from '../../lib/assistant'

// The built-in AI assistant: conversations with a model that looks after the
// NAS through the same tools as MCP clients (#138), as this account. Changes
// that need approval show up in the chat; the conversation goes on once
// they are decided.

const { t } = useI18n()
const { isAdmin } = useAuth()
const toast = useToast()
const { confirm } = useConfirm()

type Conversation = Awaited<ReturnType<typeof trpc.assistant.conversations.query>>[number]
type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; args: string; ok: boolean | null }
  | { kind: 'event'; text: string }
  | { kind: 'approval'; id: string }
  | { kind: 'error'; text: string }

const loading = ref(true)
const configuring = ref(false)
const conversations = ref<Conversation[]>([])
const currentId = ref<string | null>(null)
const items = ref<Item[]>([])
const actions = ref<Record<string, AgentRequest>>({})
const draft = ref('')
const streaming = ref(false)
const deciding = ref<string | null>(null)
const listOpen = ref(false)
const scroller = ref<HTMLElement | null>(null)
let controller: AbortController | null = null

const current = computed(() => conversations.value.find(c => c.id === currentId.value) ?? null)

function scrollDown() {
  void nextTick(() => { if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight })
}

async function loadConversations() {
  try {
    conversations.value = await trpc.assistant.conversations.query()
  } catch { /* kept as it was */ }
}

/** The tool's main argument, shown next to its name. */
function toolTarget(args: string): string {
  try {
    const a = JSON.parse(args) as Record<string, unknown>
    const v = a.path ?? a.name ?? a.query ?? a.op ?? (Array.isArray(a.paths) ? a.paths.join(', ') : undefined)
    return typeof v === 'string' ? v : ''
  } catch { return '' }
}

async function open(id: string) {
  if (streaming.value) return
  listOpen.value = false
  currentId.value = id
  items.value = []
  try {
    const c = await trpc.assistant.conversation.query({ id })
    actions.value = Object.fromEntries(c.actions.map(a => [a.id, { ...a, conversationId: c.id }]))
    const out: Item[] = []
    const tools = new Map<string, Extract<Item, { kind: 'tool' }>>()
    for (const m of c.messages) {
      if (m.role === 'user') out.push({ kind: 'user', text: m.content })
      else if (m.role === 'event') out.push({ kind: 'event', text: m.content })
      else if (m.role === 'assistant') {
        if (m.content) out.push({ kind: 'assistant', text: m.content })
        for (const call of m.toolCalls) {
          const item = { kind: 'tool' as const, id: call.id, name: call.name, args: call.arguments, ok: null }
          tools.set(call.id, item)
          out.push(item)
        }
      } else if (m.role === 'tool') {
        const item = m.toolCallId ? tools.get(m.toolCallId) : undefined
        if (item) item.ok = m.ok
        if (m.approvalId) out.push({ kind: 'approval', id: m.approvalId })
      }
    }
    items.value = out
    scrollDown()
  } catch (e: any) {
    toast.error(e?.message ?? t('assistant.loadFailed'))
    currentId.value = null
  }
}

function startNew() {
  if (streaming.value) return
  listOpen.value = false
  currentId.value = null
  items.value = []
  actions.value = {}
}

async function refreshActions() {
  if (!currentId.value) return
  try {
    const c = await trpc.assistant.conversation.query({ id: currentId.value })
    actions.value = Object.fromEntries(c.actions.map(a => [a.id, { ...a, conversationId: c.id }]))
  } catch { /* the cards keep their state */ }
}

function onEvent(e: ChatEvent) {
  const last = items.value[items.value.length - 1]
  switch (e.type) {
    case 'conversation':
      currentId.value = e.id
      if (!conversations.value.some(c => c.id === e.id)) conversations.value.unshift({ id: e.id, title: e.title, updatedAt: new Date() as never })
      break
    case 'text':
      if (last?.kind === 'assistant') last.text += e.delta
      else items.value.push({ kind: 'assistant', text: e.delta })
      break
    case 'tool':
      items.value.push({ kind: 'tool', id: e.id, name: e.name, args: e.arguments, ok: null })
      break
    case 'toolResult': {
      const item = items.value.find((i): i is Extract<Item, { kind: 'tool' }> => i.kind === 'tool' && i.id === e.id)
      if (item) item.ok = e.ok
      break
    }
    case 'approval':
      items.value.push({ kind: 'approval', id: e.id })
      void refreshActions()
      break
    case 'error':
      items.value.push({ kind: 'error', text: e.message })
      break
  }
  scrollDown()
}

async function run(body: ChatRequest) {
  streaming.value = true
  controller = new AbortController()
  try {
    await streamChat(body, onEvent, controller.signal)
  } catch (e: any) {
    if (e?.name !== 'AbortError') {
      items.value.push({ kind: 'error', text: e instanceof ChatHttpError ? e.message : t('assistant.streamFailed') })
      if (e instanceof ChatHttpError && e.status === 403) void refreshAssistantStatus()
    }
  } finally {
    streaming.value = false
    controller = null
    void loadConversations()
    scrollDown()
  }
}

async function send() {
  const message = draft.value.trim()
  if (!message || streaming.value) return
  draft.value = ''
  items.value.push({ kind: 'user', text: message })
  scrollDown()
  await run({ ...(currentId.value && { conversationId: currentId.value }), message })
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

function stop() {
  controller?.abort()
}

async function decide(id: string, approve: boolean) {
  const conversationId = currentId.value
  deciding.value = id
  try {
    if (approve) await trpc.agentAction.approve.mutate({ id })
    else await trpc.agentAction.reject.mutate({ id })
  } catch (e: any) {
    toast.error(e?.message ?? t('agentRequests.decideFailed'))
  } finally {
    deciding.value = null
  }
  await refreshActions()
  // The assistant reads the decision and goes on.
  if (conversationId && conversationId === currentId.value && !streaming.value) {
    await open(conversationId)
    await run({ conversationId, resume: true })
  }
}

async function remove(c: Conversation) {
  const ok = await confirm(t('assistant.deleteConfirm', { title: c.title || t('assistant.untitled') }), { title: t('assistant.deleteTitle'), confirmLabel: t('assistant.delete'), danger: true })
  if (!ok) return
  try {
    await trpc.assistant.deleteConversation.mutate({ id: c.id })
    conversations.value = conversations.value.filter(x => x.id !== c.id)
    if (currentId.value === c.id) startNew()
  } catch (e: any) {
    toast.error(e?.message ?? t('assistant.deleteFailed'))
  }
}

// A request of this conversation decided in the requests panel.
async function onDecidedElsewhere(e: Event) {
  const id = (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId
  if (!id || id !== currentId.value || streaming.value) return
  await open(id)
  await run({ conversationId: id, resume: true })
}

async function onConfigured() {
  configuring.value = false
  await refreshAssistantStatus()
}

const suggestions = computed(() => [t('assistant.suggest.storage'), t('assistant.suggest.apps'), t('assistant.suggest.files')])

onMounted(async () => {
  window.addEventListener(AGENT_DECIDED_EVENT, onDecidedElsewhere)
  await refreshAssistantStatus()
  if (assistantAvailable.value) await loadConversations()
  loading.value = false
})
onBeforeUnmount(() => {
  window.removeEventListener(AGENT_DECIDED_EVENT, onDecidedElsewhere)
  controller?.abort()
})
</script>

<template>
  <LoadingState v-if="loading" class="h-full" />

  <!-- Not set up: an admin sets it up here; others are told to ask one. -->
  <div v-else-if="!assistantAvailable || configuring" class="h-full overflow-auto p-4 sm:p-6">
    <div class="mx-auto max-w-xl space-y-4">
      <div v-if="!configuring" class="flex items-start gap-3">
        <BotIcon class="mt-0.5 size-5 shrink-0 text-violet" aria-hidden="true" />
        <div>
          <h2 class="text-base font-semibold text-foreground">{{ t('assistant.setupTitle') }}</h2>
          <p class="mt-1 text-sm text-muted-foreground">{{ isAdmin ? t('assistant.setupAdmin') : t('assistant.setupUser') }}</p>
        </div>
      </div>
      <Button v-if="configuring" size="sm" variant="ghost" @click="configuring = false">
        <XIcon /> {{ t('assistant.backToChat') }}
      </Button>
      <AssistantSettingsCard v-if="isAdmin" @saved="onConfigured" />
    </div>
  </div>

  <div v-else class="relative flex h-full min-h-0">
    <!-- Conversations -->
    <aside
      :class="[listOpen ? 'flex' : 'hidden', 'md:flex absolute inset-0 z-10 md:static w-full md:w-60 shrink-0 flex-col border-r bg-muted md:bg-muted/40']"
      :aria-label="t('assistant.conversations')"
    >
      <div class="flex items-center gap-2 p-2">
        <Button size="sm" variant="outline" class="flex-1 justify-start" :disabled="streaming" @click="startNew">
          <PlusIcon /> {{ t('assistant.new') }}
        </Button>
        <Button v-if="isAdmin" size="icon-sm" variant="ghost" :aria-label="t('assistant.settingsLabel')" @click="configuring = true">
          <SettingsIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" class="md:hidden" :aria-label="t('common.close')" @click="listOpen = false">
          <XIcon />
        </Button>
      </div>
      <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <p v-if="!conversations.length" class="px-2 py-3 text-xs text-muted-foreground">{{ t('assistant.noConversations') }}</p>
        <div
          v-for="c in conversations" :key="c.id"
          class="group flex items-center rounded-md"
          :class="c.id === currentId ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'"
        >
          <button
            type="button"
            class="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
            :aria-current="c.id === currentId ? 'true' : undefined"
            :disabled="streaming"
            @click="open(c.id)"
          >{{ c.title || t('assistant.untitled') }}</button>
          <Button
            size="icon-sm" variant="ghost"
            class="md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
            :aria-label="t('assistant.deleteNamed', { title: c.title || t('assistant.untitled') })"
            :disabled="streaming"
            @click="remove(c)"
          >
            <Trash2Icon />
          </Button>
        </div>
      </nav>
    </aside>

    <!-- Chat -->
    <section class="relative flex min-w-0 flex-1 flex-col">
      <div class="flex items-center gap-2 border-b px-3 py-2 md:hidden">
        <Button size="icon-sm" variant="ghost" :aria-label="t('assistant.conversations')" @click="listOpen = true"><MenuIcon /></Button>
        <p class="min-w-0 truncate text-sm font-medium">{{ current?.title || t('assistant.new') }}</p>
      </div>

      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        <div class="mx-auto max-w-3xl space-y-4 px-4 py-6">
          <EmptyState v-if="!items.length" :message="t('assistant.emptyTitle')" :description="t('assistant.emptyHint')">
            <template #icon><BotIcon /></template>
            <template #action>
              <div class="flex flex-wrap justify-center gap-2">
                <Button v-for="s in suggestions" :key="s" size="sm" variant="outline" @click="draft = s; send()">{{ s }}</Button>
              </div>
            </template>
          </EmptyState>

          <template v-for="(item, i) in items" :key="i">
            <div v-if="item.kind === 'user'" class="flex justify-end">
              <p class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2 text-sm text-primary-foreground">{{ item.text }}</p>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -- escaped by renderMarkdown -->
            <div v-else-if="item.kind === 'assistant'" class="assistant-md text-sm text-foreground" v-html="renderMarkdown(item.text)" />
            <div v-else-if="item.kind === 'tool'" class="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircleIcon v-if="item.ok === null && streaming" class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
              <CheckIcon v-else-if="item.ok !== false" class="size-3.5 shrink-0 text-success" aria-hidden="true" />
              <CircleAlertIcon v-else class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
              <WrenchIcon class="size-3 shrink-0" aria-hidden="true" />
              <span class="font-mono">{{ item.name }}</span>
              <span v-if="toolTarget(item.args)" class="min-w-0 truncate font-mono" :title="toolTarget(item.args)">{{ toolTarget(item.args) }}</span>
            </div>
            <p v-else-if="item.kind === 'event'" class="text-center text-2xs text-muted-foreground">{{ item.text }}</p>
            <template v-else-if="item.kind === 'approval'">
              <AgentRequestCard
                v-if="actions[item.id]"
                :request="actions[item.id]!" :busy="deciding === item.id" :disabled="deciding !== null || streaming"
                @decide="approve => decide(item.id, approve)"
              />
            </template>
            <p v-else class="flex items-start gap-2 rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
              <CircleAlertIcon class="mt-px size-3.5 shrink-0" aria-hidden="true" /><span class="break-words">{{ item.text }}</span>
            </p>
          </template>
          <div v-if="streaming && items[items.length - 1]?.kind !== 'assistant'" class="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircleIcon class="size-3.5 animate-spin" aria-hidden="true" /> {{ t('assistant.thinking') }}
          </div>
        </div>
      </div>

      <form class="border-t p-3" @submit.prevent="send">
        <div class="mx-auto flex max-w-3xl items-end gap-2">
          <label for="assistant-input" class="sr-only">{{ t('assistant.message') }}</label>
          <Textarea
            id="assistant-input" v-model="draft" rows="1"
            :placeholder="t('assistant.placeholder')"
            class="max-h-48 min-h-10 resize-none"
            @keydown="onKeydown"
          />
          <Button v-if="streaming" type="button" size="icon" variant="outline" :aria-label="t('assistant.stop')" @click="stop">
            <SquareIcon />
          </Button>
          <Button v-else type="submit" size="icon" :disabled="!draft.trim()" :aria-label="t('assistant.send')">
            <ArrowUpIcon />
          </Button>
        </div>
        <p class="mx-auto mt-1.5 max-w-3xl text-2xs text-muted-foreground">{{ t('assistant.disclaimer') }}</p>
      </form>
    </section>
  </div>
</template>

<style scoped>
.assistant-md :deep(p) { margin: 0.5rem 0; line-height: 1.6; }
.assistant-md :deep(p:first-child) { margin-top: 0; }
.assistant-md :deep(.md-heading) { font-weight: 600; margin-top: 1rem; }
.assistant-md :deep(ul) { list-style: disc; padding-left: 1.25rem; margin: 0.5rem 0; }
.assistant-md :deep(ol) { list-style: decimal; padding-left: 1.25rem; margin: 0.5rem 0; }
.assistant-md :deep(li) { margin: 0.2rem 0; }
.assistant-md :deep(code) { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.85em; background: var(--muted); border-radius: 0.25rem; padding: 0.05rem 0.3rem; }
.assistant-md :deep(pre) { background: var(--muted); border-radius: 0.5rem; padding: 0.6rem 0.8rem; overflow-x: auto; margin: 0.5rem 0; }
.assistant-md :deep(pre code) { background: none; padding: 0; }
.assistant-md :deep(a) { color: var(--primary); text-decoration: underline; }
.assistant-md :deep(.md-table) { overflow-x: auto; margin: 0.5rem 0; }
.assistant-md :deep(table) { border-collapse: collapse; font-size: 0.85em; }
.assistant-md :deep(th), .assistant-md :deep(td) { border: 1px solid var(--border); padding: 0.3rem 0.6rem; text-align: left; }
.assistant-md :deep(th) { background: var(--muted); font-weight: 600; }
</style>
