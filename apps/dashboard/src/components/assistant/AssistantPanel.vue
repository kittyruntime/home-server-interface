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
import { AGENT_DECIDED_EVENT, assistantAvailable, ChatHttpError, followChat, refreshAssistantStatus, stopChat, streamChat, type ChatEvent, type ChatRequest } from '../../lib/assistant'

// The built-in AI assistant: conversations with a model that looks after the
// NAS through the same tools as MCP clients (#138), as this account. Changes
// that need approval show up in the chat; the conversation goes on once
// they are decided.

const { t, te } = useI18n()
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
const conversationTokens = ref(0)
const status = ref<Awaited<ReturnType<typeof trpc.assistant.status.query>> | null>(null)
let controller: AbortController | null = null

const current = computed(() => conversations.value.find(c => c.id === currentId.value) ?? null)

async function loadStatus() {
  try { status.value = await trpc.assistant.status.query() } catch { /* the footer waits */ }
}

const fmt = (n: number) => n.toLocaleString()
const usageLine = computed(() => {
  if (!status.value) return ''
  const values = { conversation: fmt(conversationTokens.value), today: fmt(status.value.usedToday), limit: fmt(status.value.dailyLimit ?? 0) }
  return status.value.dailyLimit === null ? t('assistant.usage', values) : t('assistant.usageLimit', values)
})

/** What the tool does, in the interface language; its name when unknown. */
function toolLabel(name: string): string {
  const key = `assistant.tools.${name}`
  return te(key) ? t(key) : name
}

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

// The conversation open last, opened again when coming back to the chat.
const LAST_KEY = 'assistant.conversation'
function remember(id: string | null) {
  try { if (id) localStorage.setItem(LAST_KEY, id); else localStorage.removeItem(LAST_KEY) } catch { /* not kept */ }
}

/** Stops following the running turn, if any: the turn itself goes on. */
function leave() {
  controller?.abort()
  controller = null
  streaming.value = false
}

async function open(id: string) {
  leave()
  listOpen.value = false
  currentId.value = id
  remember(id)
  items.value = []
  try {
    const c = await trpc.assistant.conversation.query({ id })
    if (currentId.value !== id) return
    conversationTokens.value = c.tokens
    actions.value = Object.fromEntries(c.actions.map(a => [a.id, { ...a, conversationId: c.id }]))
    // A turn still running: its messages come from following it.
    const since = c.runningSince ? new Date(c.runningSince).getTime() : null
    const out: Item[] = []
    const tools = new Map<string, Extract<Item, { kind: 'tool' }>>()
    for (const m of c.messages) {
      if (since !== null && new Date(m.createdAt).getTime() >= since) break
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
    if (since !== null) await follow(signal => followChat(id, onEvent, signal))
  } catch (e: any) {
    if (currentId.value !== id) return
    toast.error(e?.message ?? t('assistant.loadFailed'))
    currentId.value = null
    remember(null)
  }
}

function startNew() {
  leave()
  listOpen.value = false
  currentId.value = null
  remember(null)
  items.value = []
  actions.value = {}
  conversationTokens.value = 0
}

async function refreshActions() {
  if (!currentId.value) return
  try {
    const c = await trpc.assistant.conversation.query({ id: currentId.value })
    actions.value = Object.fromEntries(c.actions.map(a => [a.id, { ...a, conversationId: c.id }]))
  } catch { /* the cards keep their state */ }
}

// The message just sent, shown at once: the turn's own copy of it is skipped.
let sentText: string | null = null

function onEvent(e: ChatEvent) {
  const last = items.value[items.value.length - 1]
  switch (e.type) {
    case 'conversation':
      currentId.value = e.id
      remember(e.id)
      if (!conversations.value.some(c => c.id === e.id)) conversations.value.unshift({ id: e.id, title: e.title, updatedAt: new Date() as never, running: true })
      break
    case 'user':
      if (sentText === e.text) sentText = null
      else items.value.push({ kind: 'user', text: e.text })
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
    case 'usage':
      conversationTokens.value += e.tokens
      if (status.value) status.value.usedToday += e.tokens
      break
  }
  scrollDown()
}

/** Follows a turn until it ends, or until this chat leaves it. */
async function follow(stream: (signal: AbortSignal) => Promise<void>) {
  leave()
  const mine = new AbortController()
  controller = mine
  streaming.value = true
  try {
    await stream(mine.signal)
  } catch (e: any) {
    if (e?.name !== 'AbortError' && controller === mine) {
      items.value.push({ kind: 'error', text: e instanceof ChatHttpError ? e.message : t('assistant.streamFailed') })
      if (e instanceof ChatHttpError && e.status === 403) void refreshAssistantStatus()
    }
  } finally {
    if (controller === mine) {
      streaming.value = false
      controller = null
      void loadConversations()
      void loadStatus()
      scrollDown()
    }
  }
}

async function send() {
  const message = draft.value.trim()
  if (!message || streaming.value) return
  draft.value = ''
  items.value.push({ kind: 'user', text: message })
  sentText = message
  scrollDown()
  const body: ChatRequest = { ...(currentId.value && { conversationId: currentId.value }), message }
  await follow(signal => streamChat(body, onEvent, signal))
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

// Stops the turn on the server; following it ends with it.
async function stop() {
  if (currentId.value) await stopChat(currentId.value)
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
  // The server goes on with the decision: follow it.
  if (conversationId && conversationId === currentId.value) await open(conversationId)
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

// A request of this conversation decided in the requests panel: the server
// goes on with it, follow it.
async function onDecidedElsewhere(e: Event) {
  const id = (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId
  if (id && id === currentId.value) await open(id)
}

// While a turn runs in another conversation, its mark in the list follows it.
let listTimer: ReturnType<typeof setInterval> | undefined

async function onConfigured() {
  configuring.value = false
  await refreshAssistantStatus()
}

const suggestions = computed(() => [t('assistant.suggest.storage'), t('assistant.suggest.apps'), t('assistant.suggest.files')])

onMounted(async () => {
  window.addEventListener(AGENT_DECIDED_EVENT, onDecidedElsewhere)
  await refreshAssistantStatus()
  if (assistantAvailable.value) await Promise.all([loadConversations(), loadStatus()])
  loading.value = false
  listTimer = setInterval(() => { if (conversations.value.some(c => c.running && c.id !== currentId.value)) void loadConversations() }, 5_000)
  let last: string | null = null
  try { last = localStorage.getItem(LAST_KEY) } catch { /* none */ }
  if (last && conversations.value.some(c => c.id === last)) void open(last)
})
onBeforeUnmount(() => {
  window.removeEventListener(AGENT_DECIDED_EVENT, onDecidedElsewhere)
  clearInterval(listTimer)
  // Leaving the chat only stops following: the turn goes on on the server.
  leave()
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
        <Button size="sm" variant="outline" class="flex-1 justify-start" @click="startNew">
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
            @click="open(c.id)"
          ><LoaderCircleIcon v-if="c.running" class="mr-1.5 inline size-3 animate-spin text-muted-foreground" :aria-label="t('assistant.running')" />{{ c.title || t('assistant.untitled') }}</button>
          <Button
            size="icon-sm" variant="ghost"
            class="md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
            :aria-label="t('assistant.deleteNamed', { title: c.title || t('assistant.untitled') })"
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
          <EmptyState v-if="!items.length" :message="t('assistant.emptyTitle')" :description="status?.readOnly ? t('assistant.readOnlyNote') : t('assistant.emptyHint')">
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
              <span :title="item.name">{{ toolLabel(item.name) }}</span>
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
        <p class="mx-auto mt-1.5 flex max-w-3xl flex-wrap justify-between gap-x-4 gap-y-0.5 text-2xs text-muted-foreground">
          <span>{{ t('assistant.disclaimer') }}</span>
          <span v-if="usageLine" class="tabular-nums">{{ usageLine }}</span>
        </p>
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
