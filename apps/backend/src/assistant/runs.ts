import type { ChatEvent } from "./chat"

// The built-in assistant's turns run on the server, apart from the request
// that started them: leaving the chat or closing the page does not stop one.
// The dashboard follows a turn as it goes and can come back to it: whoever
// subscribes gets what happened so far, then the rest. Stop is explicit.

export interface Run {
  conversationId: string
  userId: string
  /** Messages of the conversation older than this were there before the turn. */
  startedAt: Date
  controller: AbortController
  events: ChatEvent[]
  subscribers: Set<(e: ChatEvent) => void>
  done: boolean
}

const runs = new Map<string, Run>()

export function getRun(conversationId: string): Run | undefined {
  return runs.get(conversationId)
}

export function runningConversations(userId: string): Set<string> {
  return new Set([...runs.values()].filter(r => r.userId === userId).map(r => r.conversationId))
}

/** A new turn for the conversation, or null when one is already running. */
export function startRun(conversationId: string, userId: string): Run | null {
  if (runs.has(conversationId)) return null
  const run: Run = {
    conversationId, userId, startedAt: new Date(), controller: new AbortController(),
    events: [], subscribers: new Set(), done: false,
  }
  runs.set(conversationId, run)
  return run
}

/** Records an event and passes it on. Text pieces are kept merged, so a late subscriber gets few events. */
export function emitRun(run: Run, e: ChatEvent) {
  if (run.done) return
  const last = run.events[run.events.length - 1]
  if (e.type === "text" && last?.type === "text") run.events[run.events.length - 1] = { type: "text", delta: last.delta + e.delta }
  else run.events.push(e)
  for (const s of run.subscribers) s(e)
}

export function finishRun(run: Run) {
  if (run.done) return
  emitRun(run, { type: "done" })
  run.done = true
  run.subscribers.clear()
  if (runs.get(run.conversationId) === run) runs.delete(run.conversationId)
}

/** Replays the turn so far, then follows it; returns the unsubscribe function. */
export function subscribe(run: Run, fn: (e: ChatEvent) => void): () => void {
  for (const e of run.events) fn(e)
  if (run.done) return () => {}
  run.subscribers.add(fn)
  return () => { run.subscribers.delete(fn) }
}

/** Stops a turn; true when there was one. */
export function stopRun(conversationId: string, userId: string): boolean {
  const run = runs.get(conversationId)
  if (!run || run.userId !== userId) return false
  run.controller.abort()
  return true
}
