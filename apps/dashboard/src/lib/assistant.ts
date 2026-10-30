import { ref } from 'vue'
import { trpc } from './trpc'
import { useAuth } from './auth'

// The built-in AI assistant: whether this account can use it, and the stream
// of one turn of a conversation (server-sent events over a POST).

export type ChatEvent =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; arguments: string }
  | { type: 'toolResult'; id: string; ok: boolean }
  | { type: 'approval'; id: string }
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

export type ChatRequest = { conversationId?: string; message: string } | { conversationId: string; resume: true }

/** Runs one turn, calling onEvent for each event until the stream ends. */
export async function streamChat(body: ChatRequest, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const token = localStorage.getItem('token')
  const res = await fetch('/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
    signal,
  })
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
