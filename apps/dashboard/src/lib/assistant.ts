import { ref } from 'vue'
import { trpc } from './trpc'
import { useAuth } from './auth'

// The built-in AI assistant: whether this account can use it, and its turns,
// which run on the server and are followed as server-sent events.

export type ChatEvent =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'user'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; arguments: string }
  | { type: 'toolResult'; id: string; ok: boolean }
  | { type: 'approval'; id: string }
  | { type: 'usage'; tokens: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

/** Sent when a request of the built-in assistant is decided, wherever it was. */
export const AGENT_DECIDED_EVENT = 'hsi:agent-decided'

export const assistantAvailable = ref(false)

/** The nav's capability check: the assistant shows when this account may use it. */
export function navCapability(capability: string): boolean {
  return capability === 'assistant' ? assistantAvailable.value : useAuth().hasCapability(capability).value
}

export async function refreshAssistantStatus() {
  try {
    assistantAvailable.value = (await trpc.assistant.status.query()).available
  } catch {
    assistantAvailable.value = false
  }
}

export class ChatHttpError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export type ChatRequest = { conversationId?: string; message: string }

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token')
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function readEvents(res: Response, onEvent: (e: ChatEvent) => void): Promise<void> {
  if (!res.ok || !res.body) {
    const error = await res.json().catch(() => null) as { error?: string } | null
    throw new ChatHttpError(error?.error ?? res.statusText, res.status)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        try { onEvent(JSON.parse(line.slice(5).trim()) as ChatEvent) } catch { /* a broken event is skipped */ }
      }
    }
    if (done) break
  }
}

/**
 * Starts a turn and follows it. The turn runs on the server: aborting the
 * signal only stops following it (stopChat stops it).
 */
export async function streamChat(body: ChatRequest, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch('/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  })
  await readEvents(res, onEvent)
}

/** Follows the conversation's running turn from its start (ends at once when none runs). */
export async function followChat(conversationId: string, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`/assistant/chat/${encodeURIComponent(conversationId)}/events`, { headers: authHeaders(), signal })
  await readEvents(res, onEvent)
}

export async function stopChat(conversationId: string): Promise<void> {
  await fetch(`/assistant/chat/${encodeURIComponent(conversationId)}/stop`, { method: 'POST', headers: authHeaders() }).catch(() => {})
}
