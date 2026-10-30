// A client for the OpenAI-compatible Chat Completions API, which OpenRouter,
// OpenAI, Anthropic, Mistral, Ollama and most others serve: streamed text and
// tool calls. No SDK: the protocol is small, and each provider bends it a
// little.

export interface ChatToolCall {
  id: string
  name: string
  arguments: string
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string }

export interface ChatTool {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ProviderTarget {
  baseUrl: string
  apiKey: string | null
  model: string
}

export interface ChatReply {
  content: string
  toolCalls: ChatToolCall[]
  finishReason: string | null
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = "ProviderError"
  }
}

function headers(target: ProviderTarget): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(target.apiKey && { authorization: `Bearer ${target.apiKey}` }),
    // OpenRouter shows where requests come from; others ignore these.
    "x-title": "Home Server Interface",
    "http-referer": "https://github.com/kittyruntime/home-server-interface",
  }
}

/** The provider's error message, from its JSON body when there is one. */
async function errorOf(res: Response): Promise<ProviderError> {
  const text = await res.text().catch(() => "")
  let message = text.slice(0, 500)
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    message = (typeof body.error === "string" ? body.error : body.error?.message) ?? body.message ?? message
  } catch { /* not JSON */ }
  return new ProviderError(`The AI provider answered ${res.status}${message ? `: ${message}` : ""}`, res.status)
}

/** Reads a server-sent event stream, line by line, and yields each data payload. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "")
      buffer = buffer.slice(nl + 1)
      if (line.startsWith("data:")) yield line.slice(5).trimStart()
    }
    if (done) break
  }
  if (buffer.startsWith("data:")) yield buffer.slice(5).trimStart()
}

interface StreamChunk {
  error?: { message?: string } | string
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
}

/** Folds the stream's chunks into one reply, calling onText for each piece of text. */
export async function collectStream(data: AsyncIterable<string>, onText: (delta: string) => void): Promise<ChatReply> {
  let content = ""
  let finishReason: string | null = null
  const calls = new Map<number, ChatToolCall>()
  for await (const payload of data) {
    if (payload === "[DONE]") break
    let chunk: StreamChunk
    try { chunk = JSON.parse(payload) as StreamChunk } catch { continue }
    if (chunk.error) {
      throw new ProviderError(`The AI provider failed: ${typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "unknown error"}`)
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.delta?.content) {
      content += choice.delta.content
      onText(choice.delta.content)
    }
    for (const [i, tc] of (choice.delta?.tool_calls ?? []).entries()) {
      const index = tc.index ?? i
      const call = calls.get(index) ?? { id: "", name: "", arguments: "" }
      if (tc.id) call.id = tc.id
      if (tc.function?.name) call.name += tc.function.name
      if (tc.function?.arguments) call.arguments += tc.function.arguments
      calls.set(index, call)
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }))
  return { content, toolCalls: toolCalls.filter(c => c.name), finishReason }
}

export async function streamChat(
  target: ProviderTarget,
  messages: ChatMessage[],
  tools: ChatTool[],
  onText: (delta: string) => void,
  signal: AbortSignal,
): Promise<ChatReply> {
  const res = await fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(target),
    body: JSON.stringify({ model: target.model, messages, stream: true, ...(tools.length && { tools }) }),
    signal,
  })
  if (!res.ok) throw await errorOf(res)
  if (!res.body) throw new ProviderError("The AI provider sent an empty answer")
  return collectStream(sseData(res.body), onText)
}

/** The models the provider offers, to check the settings and pick one. */
export async function listModels(target: Omit<ProviderTarget, "model">, signal: AbortSignal): Promise<string[]> {
  const res = await fetch(`${target.baseUrl}/models`, { headers: headers({ ...target, model: "" }), signal })
  if (!res.ok) throw await errorOf(res)
  const body = await res.json() as { data?: { id?: string }[] }
  return (body.data ?? []).map(m => m.id).filter((id): id is string => typeof id === "string").sort()
}
