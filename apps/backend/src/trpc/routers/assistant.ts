import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { router, protectedProcedure, adminProcedure } from "../index"
import {
  ASSISTANT_PROVIDERS, assistantAllowed, assistantSettingsView, loadAssistantConfig, saveAssistantSettings, tokensUsedToday, type AssistantProvider,
} from "../../services/assistant-settings"
import { listModels } from "../../services/assistant-provider"
import { SecretsError } from "../../services/secrets"
import { parseIds } from "../../services/ai-exclusions"

// The built-in assistant: its settings (administrators) and each account's
// conversations. Closed to AI assistants themselves (closedToApiTokens).

const providers = Object.keys(ASSISTANT_PROVIDERS) as [AssistantProvider, ...AssistantProvider[]]

const baseUrl = z.string().trim().max(500).refine(u => {
  try { return ["http:", "https:"].includes(new URL(u).protocol) } catch { return false }
}, "An http:// or https:// address")

const shownAction = {
  id: true, tool: true, reason: true, title: true, preview: true, destructive: true, status: true,
  result: true, error: true, createdAt: true, expiresAt: true, decidedAt: true,
} as const

function parse(s: string | null): unknown {
  try { return s ? JSON.parse(s) : null } catch { return null }
}

export const assistantRouter = router({
  // Whether this account can chat, with which model, and what it used today.
  status: protectedProcedure.query(async ({ ctx }) => {
    const config = await loadAssistantConfig()
    const available = assistantAllowed(config, ctx.user)
    return {
      available,
      model: available ? config.model : null,
      readOnly: config.readOnly,
      usedToday: available ? await tokensUsedToday(ctx.user.userId) : 0,
      dailyLimit: config.dailyTokenLimit,
    }
  }),

  settings: adminProcedure.query(() => assistantSettingsView()),

  saveSettings: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
      provider: z.enum(providers),
      baseUrl,
      model: z.string().trim().max(200),
      access: z.enum(["admins", "everyone"]),
      readOnly: z.boolean().default(false),
      dailyTokenLimit: z.number().int().min(1_000).max(100_000_000).nullable().default(null),
      apiKey: z.string().trim().min(1).max(500).nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      if (input.enabled && !input.model) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a model first" })
      try {
        await saveAssistantSettings(input)
      } catch (e) {
        if (e instanceof SecretsError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "HSI_SECRETS_KEY is missing: the key cannot be stored" })
        throw e
      }
      return assistantSettingsView()
    }),

  // Reaches the provider with these settings and lists its models. Without a
  // new key, the stored one is used. A mutation: the key stays out of URLs.
  testSettings: adminProcedure
    .input(z.object({ baseUrl, apiKey: z.string().trim().min(1).max(500).optional() }))
    .mutation(async ({ input }) => {
      const stored = await loadAssistantConfig()
      const apiKey = input.apiKey ?? stored.apiKey
      try {
        const models = await listModels({ baseUrl: input.baseUrl.replace(/\/+$/, ""), apiKey }, AbortSignal.timeout(15_000))
        return { ok: true as const, models: models.slice(0, 2000) }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    }),

  // Places closed to every AI assistant, built-in or over MCP.
  excludedPlaces: adminProcedure.query(async ({ ctx }) => {
    const row = await ctx.prisma.assistantSettings.findUnique({ where: { id: 1 }, select: { excludedPlaceIds: true } })
    return { placeIds: parseIds(row?.excludedPlaceIds) }
  }),

  setExcludedPlaces: adminProcedure
    .input(z.object({ placeIds: z.array(z.string()).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const known = await ctx.prisma.place.findMany({ where: { id: { in: input.placeIds } }, select: { id: true, name: true } })
      ctx.audit.target = known.map(p => p.name).join(", ") || "none"
      const excludedPlaceIds = JSON.stringify(known.map(p => p.id))
      await ctx.prisma.assistantSettings.upsert({ where: { id: 1 }, create: { id: 1, excludedPlaceIds }, update: { excludedPlaceIds } })
      return { placeIds: known.map(p => p.id) }
    }),

  conversations: protectedProcedure.query(({ ctx }) =>
    ctx.prisma.assistantConversation.findMany({
      where: { userId: ctx.user.userId }, orderBy: { updatedAt: "desc" }, select: { id: true, title: true, updatedAt: true },
    })),

  // A conversation as the chat shows it, with the requests it made.
  conversation: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.assistantConversation.findFirst({
        where: { id: input.id, userId: ctx.user.userId },
        select: {
          id: true, title: true, tokens: true,
          messages: { orderBy: { createdAt: "asc" }, select: { id: true, role: true, content: true, toolCalls: true, toolCallId: true, toolName: true, createdAt: true } },
        },
      })
      if (!conversation) throw new TRPCError({ code: "NOT_FOUND" })
      const actions = await ctx.prisma.agentAction.findMany({ where: { conversationId: conversation.id, userId: ctx.user.userId }, select: shownAction })
      const now = new Date()
      return {
        id: conversation.id,
        title: conversation.title,
        tokens: conversation.tokens,
        messages: conversation.messages.map(m => {
          if (m.role !== "tool") return { ...m, toolCalls: (parse(m.toolCalls) ?? []) as { id: string; name: string; arguments: string }[], ok: true, approvalId: null }
          const result = parse(m.content) as { error?: unknown; requestId?: unknown; status?: unknown } | null
          return {
            ...m, toolCalls: [],
            ok: !(result && typeof result === "object" && "error" in result),
            approvalId: result?.status === "pending" && typeof result.requestId === "string" ? result.requestId : null,
          }
        }),
        actions: actions.map(a => ({
          ...a, preview: parse(a.preview), result: parse(a.result),
          status: a.status === "pending" && a.expiresAt <= now ? "expired" : a.status,
        })),
      }
    }),

  deleteConversation: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.prisma.assistantConversation.deleteMany({ where: { id: input.id, userId: ctx.user.userId } })
      if (!r.count) throw new TRPCError({ code: "NOT_FOUND" })
      // Its requests still waiting are dropped with it.
      await ctx.prisma.agentAction.updateMany({ where: { conversationId: input.id, status: "pending" }, data: { status: "rejected", decidedAt: new Date(), input: "{}" } })
      return { ok: true }
    }),
})
