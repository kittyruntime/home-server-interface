import crypto from "node:crypto"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { TokenPayload } from "../trpc/auth"
import { z } from "zod"
import { prisma } from "@app/database"
import { authenticateRequest } from "../utils/request-auth"
import { HSI_VERSION } from "../version"
import { ALL_TOOLS, runGuarded, toolContext, toolErrorPayload } from "../mcp/context"
import { loadExclusions } from "../services/ai-exclusions"
import { assistantAllowed, loadAssistantConfig, recordUsage, tokensUsedToday } from "../services/assistant-settings"
import { streamChat } from "../services/assistant-provider"
import { log } from "../utils/log"
import {
  chatTools, chatUser, familiesUsed, historyForModel, loadFamilies, LOAD_TOOLS, runToolCall, runTurn, systemPrompt, titleOf, DAILY_LIMIT_MESSAGE, HISTORY_MESSAGES, type ChatEvent,
} from "./chat"
import { emitRun, finishRun, getRun, runningConversations, startRun, stopRun, subscribe, type Run } from "./runs"

// The built-in assistant's chat. A turn runs on the server (runs.ts): the
// request that starts it follows it as server-sent events, and the dashboard
// can come back to it later. Leaving the page does not stop it; Stop does.
// The dashboard's session signs in; the tools run as that account.

/** Conversations kept per account; the oldest go first. */
export const MAX_CONVERSATIONS = 50
const MAX_MESSAGE_CHARS = 20_000
const PER_USER_PER_MINUTE = 20

const body = z.union([
  z.object({ conversationId: z.string().uuid().optional(), message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) }),
  // Goes on after a request of the conversation was decided (its note is in).
  z.object({ conversationId: z.string().uuid(), resume: z.literal(true) }),
])

// Providers that report the tokens of a streamed call when asked to.
const REPORTS_USAGE = new Set(["openrouter", "openai"])

type Session = Omit<TokenPayload, "jti"> & { jti: string }

async function pruneConversations(userId: string) {
  const old = await prisma.assistantConversation.findMany({
    where: { userId }, orderBy: { updatedAt: "desc" }, skip: MAX_CONVERSATIONS, select: { id: true },
  })
  // A conversation whose turn is running stays.
  const running = runningConversations(userId)
  const gone = old.map(c => c.id).filter(id => !running.has(id))
  if (gone.length) await prisma.assistantConversation.deleteMany({ where: { id: { in: gone } } })
}

export class TurnRefused extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * Starts a turn of the assistant in a conversation (a new one without an id),
 * running on the server until the model answered, a request waits for
 * approval, the daily limit is reached or the user stops it.
 */
export async function startTurn(session: Session, input: { conversationId?: string; message?: string }, ip: string): Promise<Run> {
  if (session.mustChangePassword) throw new TurnRefused("Change your password first", 403)
  const config = await loadAssistantConfig()
  if (!assistantAllowed(config, session)) throw new TurnRefused("The assistant is not available to this account", 403)
  let conversation = input.conversationId
    ? await prisma.assistantConversation.findFirst({ where: { id: input.conversationId, userId: session.userId } })
    : null
  if (input.conversationId && !conversation) throw new TurnRefused("Unknown conversation", 404)
  if (conversation && getRun(conversation.id)) throw new TurnRefused("The assistant is still answering in this conversation", 409)
  let usedToday = await tokensUsedToday(session.userId)
  const limit = config.dailyTokenLimit
  if (limit !== null && usedToday >= limit) throw new TurnRefused(DAILY_LIMIT_MESSAGE, 429)

  if (!conversation) {
    conversation = await prisma.assistantConversation.create({ data: { userId: session.userId, title: titleOf(input.message ?? "") } })
    await pruneConversations(session.userId)
  }
  const conversationId = conversation.id
  const run = startRun(conversationId, session.userId)
  if (!run) throw new TurnRefused("The assistant is still answering in this conversation", 409)
  const emit = (e: ChatEvent) => emitRun(run, e)
  const signal = run.controller.signal
  // The tools run apart from any request: the caller's address, for the audit log.
  const origin = { ip, headers: {} }

  emit({ type: "conversation", id: conversationId, title: conversation.title })
  void (async () => {
    try {
      if (input.message) {
        await prisma.assistantMessage.create({ data: { conversationId, role: "user", content: input.message } })
        emit({ type: "user", text: input.message })
      }
      const user = chatUser(session)
      const toolset = chatTools(ALL_TOOLS, user, config.readOnly)
      const used = await prisma.assistantMessage.findMany({ where: { conversationId, role: "tool" }, distinct: ["toolName"], select: { toolName: true } })
      const loaded = familiesUsed(used.map(m => m.toolName), toolset.defs)
      const exclusions = await loadExclusions()
      const account = await prisma.user.findUnique({ where: { id: session.userId }, select: { username: true } })
      const stored = await prisma.assistantMessage.findMany({
        where: { conversationId }, orderBy: { createdAt: "desc" }, take: HISTORY_MESSAGES,
        select: { role: true, content: true, toolCalls: true, toolCallId: true },
      })
      const target = { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model }
      await runTurn(
        systemPrompt({ username: account?.username ?? "the user", isAdmin: session.isAdmin, version: HSI_VERSION, now: new Date(), readOnly: config.readOnly }),
        historyForModel(stored.reverse()),
        {
          stream: (messages, tools, onText) => streamChat(target, messages, tools, onText, signal, { reportUsage: REPORTS_USAGE.has(config.provider) }),
          tools: () => toolset.offered(loaded),
          used: async tokens => {
            usedToday += tokens
            await recordUsage(session.userId, conversationId, tokens)
            emit({ type: "usage", tokens })
            return limit === null || usedToday < limit
          },
          runTool: async call => call.name === LOAD_TOOLS
            ? loadFamilies(call.arguments, toolset.families, loaded)
            : runToolCall(
              call, toolset.defs,
              (def, args) => runGuarded(def, args as Record<string, unknown>, toolContext(origin, user, { via: "assistant", conversationId }, def.name), exclusions),
              toolErrorPayload,
            ),
          save: m => prisma.assistantMessage.create({
            data: {
              conversationId, role: m.role, content: m.content,
              toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null, toolCallId: m.toolCallId ?? null, toolName: m.toolName ?? null,
            },
          }).then(() => {}),
          emit,
          aborted: () => signal.aborted,
        },
      )
    } catch (e) {
      if (!signal.aborted) {
        log.warn({ err: e }, "assistant: the turn failed")
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      await prisma.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => {})
      finishRun(run)
    }
  })()
  return run
}

/** Sends a turn's events to a request, from the start, until the turn ends or the request goes. */
function follow(run: Run, reply: FastifyReply) {
  reply.hijack()
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  })
  let unsubscribe = () => {}
  const send = (e: ChatEvent) => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return
    reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    if (e.type === "done") { unsubscribe(); reply.raw.end() }
  }
  // Leaving only stops following: the turn goes on.
  reply.raw.on("close", () => unsubscribe())
  unsubscribe = subscribe(run, send)
}

async function signedIn(req: FastifyRequest, reply: FastifyReply): Promise<Session | null> {
  const session = await authenticateRequest(req)
  if (!session) { void reply.status(401).send({ error: "Unauthorized" }); return null }
  return session
}

const rateLimit = {
  max: PER_USER_PER_MINUTE,
  timeWindow: "1 minute",
  keyGenerator: (req: FastifyRequest) => "assistant:" + crypto.createHash("sha256").update(req.headers.authorization ?? req.ip).digest("hex"),
}

export async function assistantRoutes(app: FastifyInstance) {
  app.post("/assistant/chat", { bodyLimit: 128 * 1024, config: { rateLimit } }, async (req, reply) => {
    const session = await signedIn(req, reply)
    if (!session) return
    const parsed = body.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: "Invalid request" })
    let run: Run
    try {
      run = await startTurn(session, parsed.data, req.ip)
    } catch (e) {
      if (e instanceof TurnRefused) return reply.status(e.status).send({ error: e.message })
      throw e
    }
    follow(run, reply)
  })

  // Follows the conversation's running turn from its start; ends at once when none runs.
  app.get<{ Params: { id: string } }>("/assistant/chat/:id/events", async (req, reply) => {
    const session = await signedIn(req, reply)
    if (!session) return
    const run = getRun(req.params.id)
    if (!run || run.userId !== session.userId) {
      reply.hijack()
      reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" })
      reply.raw.end(`data: ${JSON.stringify({ type: "done" })}\n\n`)
      return
    }
    follow(run, reply)
  })

  app.post<{ Params: { id: string } }>("/assistant/chat/:id/stop", async (req, reply) => {
    const session = await signedIn(req, reply)
    if (!session) return
    return { stopped: stopRun(req.params.id, session.userId) }
  })
}
