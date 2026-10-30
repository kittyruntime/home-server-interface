import crypto from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { prisma } from "@app/database"
import { authenticateRequest } from "../utils/request-auth"
import { HSI_VERSION } from "../version"
import { ALL_TOOLS, toolContext, toolErrorPayload } from "../mcp/context"
import { assistantAllowed, loadAssistantConfig, recordUsage, tokensUsedToday } from "../services/assistant-settings"
import { streamChat } from "../services/assistant-provider"
import { log } from "../utils/log"
import {
  chatTools, chatUser, historyForModel, runToolCall, runTurn, systemPrompt, titleOf, DAILY_LIMIT_MESSAGE, HISTORY_MESSAGES, type ChatEvent,
} from "./chat"

// The built-in assistant's chat: one turn per request, streamed to the
// dashboard as server-sent events. The dashboard's session signs in; the
// tools run as that account.

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

// One turn at a time in a conversation: a second tab waits for the first.
const busy = new Set<string>()

async function pruneConversations(userId: string) {
  const old = await prisma.assistantConversation.findMany({
    where: { userId }, orderBy: { updatedAt: "desc" }, skip: MAX_CONVERSATIONS, select: { id: true },
  })
  if (old.length) await prisma.assistantConversation.deleteMany({ where: { id: { in: old.map(c => c.id) } } })
}

export async function assistantRoutes(app: FastifyInstance) {
  app.post("/assistant/chat", {
    bodyLimit: 128 * 1024,
    config: {
      rateLimit: {
        max: PER_USER_PER_MINUTE,
        timeWindow: "1 minute",
        keyGenerator: (req: FastifyRequest) => "assistant:" + crypto.createHash("sha256").update(req.headers.authorization ?? req.ip).digest("hex"),
      },
    },
  }, async (req, reply) => {
    const session = await authenticateRequest(req)
    if (!session) return reply.status(401).send({ error: "Unauthorized" })
    if (session.mustChangePassword) return reply.status(403).send({ error: "Change your password first" })
    const config = await loadAssistantConfig()
    if (!assistantAllowed(config, session)) return reply.status(403).send({ error: "The assistant is not available to this account" })
    const parsed = body.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: "Invalid request" })
    const input = parsed.data

    let conversation = input.conversationId
      ? await prisma.assistantConversation.findFirst({ where: { id: input.conversationId, userId: session.userId } })
      : null
    if (input.conversationId && !conversation) return reply.status(404).send({ error: "Unknown conversation" })
    if (conversation && busy.has(conversation.id)) return reply.status(409).send({ error: "The assistant is still answering in this conversation" })
    let usedToday = await tokensUsedToday(session.userId)
    const limit = config.dailyTokenLimit
    if (limit !== null && usedToday >= limit) return reply.status(429).send({ error: DAILY_LIMIT_MESSAGE })

    if (!conversation) {
      conversation = await prisma.assistantConversation.create({ data: { userId: session.userId, title: titleOf("message" in input ? input.message : "") } })
      await pruneConversations(session.userId)
    }
    const conversationId = conversation.id
    busy.add(conversationId)

    const controller = new AbortController()
    reply.raw.on("close", () => controller.abort())
    reply.hijack()
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    })
    const emit = (e: ChatEvent) => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    }

    try {
      emit({ type: "conversation", id: conversationId, title: conversation.title })
      if ("message" in input) await prisma.assistantMessage.create({ data: { conversationId, role: "user", content: input.message } })
      const user = chatUser(session)
      const { defs, schemas } = chatTools(ALL_TOOLS, user, config.readOnly)
      const toolChars = JSON.stringify(schemas).length
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
          stream: (messages, onText) => streamChat(target, messages, schemas, onText, controller.signal, { reportUsage: REPORTS_USAGE.has(config.provider) }),
          toolChars,
          used: async tokens => {
            usedToday += tokens
            await recordUsage(session.userId, conversationId, tokens)
            emit({ type: "usage", tokens })
            return limit === null || usedToday < limit
          },
          runTool: call => runToolCall(
            call, defs,
            (def, args) => def.run(args as never, toolContext(req, reply, user, { via: "assistant", conversationId }, def.name)),
            toolErrorPayload,
          ),
          save: m => prisma.assistantMessage.create({
            data: {
              conversationId, role: m.role, content: m.content,
              toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null, toolCallId: m.toolCallId ?? null, toolName: m.toolName ?? null,
            },
          }).then(() => {}),
          emit,
          aborted: () => controller.signal.aborted,
        },
      )
    } catch (e) {
      if (!controller.signal.aborted) {
        log.warn({ err: e }, "assistant: the turn failed")
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      busy.delete(conversationId)
      await prisma.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => {})
      emit({ type: "done" })
      reply.raw.end()
    }
  })
}
