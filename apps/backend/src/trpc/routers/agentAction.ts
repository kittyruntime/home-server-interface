import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { router, protectedProcedure } from "../index"
import type { Context } from "../context"
import { APPROVAL_PROCEDURES, decidable, decisionNote, outcome } from "../../services/agent-actions"
import { parseScopes, tokenUsable, type ApiTokenAuth } from "../../services/api-tokens"
import { assistantAllowed, loadAssistantConfig } from "../../services/assistant-settings"

// Approving or rejecting what an AI assistant asked for (#138), over MCP or in
// the built-in chat. Signed-in sessions only (closedToApiTokens): an assistant
// never approves itself.

const MAX_RESULT_CHARS = 64_000

const shown = {
  id: true, tool: true, reason: true, title: true, preview: true, destructive: true, status: true,
  result: true, error: true, createdAt: true, expiresAt: true, decidedAt: true, tokenId: true, conversationId: true,
} as const

function view<T extends { preview: string; result: string | null }>(a: T) {
  const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null } catch { return null } }
  return { ...a, preview: parse(a.preview), result: parse(a.result) }
}

// The built-in assistant is told the decision, and goes on with it on the
// server, whether or not its chat is open.
async function tellChat(ctx: Pick<Context, "prisma" | "req"> & { user: NonNullable<Context["user"]> }, conversationId: string, note: string) {
  await ctx.prisma.assistantMessage.create({ data: { conversationId, role: "event", content: note } }).catch(() => {})
  const { startTurn } = await import("../../assistant/route")
  // Refused when a turn already runs there, or the daily limit is reached: the note waits for the next one.
  await startTurn(ctx.user, { conversationId }, ctx.req.ip).catch(() => {})
}

export const agentActionRouter = router({
  // The account's actions waiting for a decision, then the latest decided ones.
  list: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date()
    await ctx.prisma.agentAction.updateMany({ where: { userId: ctx.user.userId, status: "pending", expiresAt: { lte: now } }, data: { status: "expired", input: "{}" } })
    const [pending, recent] = await Promise.all([
      ctx.prisma.agentAction.findMany({ where: { userId: ctx.user.userId, status: "pending" }, select: shown, orderBy: { createdAt: "asc" } }),
      ctx.prisma.agentAction.findMany({ where: { userId: ctx.user.userId, status: { not: "pending" } }, select: shown, orderBy: { createdAt: "desc" }, take: 20 }),
    ])
    const names = new Map((await ctx.prisma.apiToken.findMany({
      where: { id: { in: [...new Set([...pending, ...recent].flatMap(a => a.tokenId ? [a.tokenId] : []))] } }, select: { id: true, name: true },
    })).map(t => [t.id, t.name]))
    // tokenName null: the built-in assistant (conversationId set), or a token since deleted.
    const withToken = <T extends { tokenId: string | null }>(a: T) => ({ ...a, tokenName: a.tokenId ? names.get(a.tokenId) ?? null : null })
    return { pending: pending.map(view).map(withToken), recent: recent.map(view).map(withToken) }
  }),

  // Runs exactly the stored call, as this account, recorded as the assistant's.
  approve: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const action = await ctx.prisma.agentAction.findUnique({ where: { id: input.id } })
      if (!action || action.userId !== ctx.user.userId) throw new TRPCError({ code: "NOT_FOUND" })
      ctx.audit.target = action.title
      if (!decidable(action)) throw new TRPCError({ code: "CONFLICT", message: "This request was already decided, or it expired" })
      let apiToken: ApiTokenAuth | null = null
      if (action.tokenId) {
        const token = await ctx.prisma.apiToken.findUnique({ where: { id: action.tokenId } })
        if (!token || !tokenUsable(token)) {
          await ctx.prisma.agentAction.update({ where: { id: action.id }, data: { status: "rejected", decidedAt: new Date(), error: "The access token was revoked or expired", input: "{}" } })
          throw new TRPCError({ code: "FORBIDDEN", message: "The assistant's access token was revoked or expired: the request is dropped" })
        }
        apiToken = { id: token.id, scopes: parseScopes(token.scopes) }
      } else if (!assistantAllowed(await loadAssistantConfig(), ctx.user)) {
        await ctx.prisma.agentAction.update({ where: { id: action.id }, data: { status: "rejected", decidedAt: new Date(), error: "The built-in assistant was turned off", input: "{}" } })
        throw new TRPCError({ code: "FORBIDDEN", message: "The built-in assistant was turned off: the request is dropped" })
      }
      const run = APPROVAL_PROCEDURES[action.procedure]
      if (!run) throw new TRPCError({ code: "BAD_REQUEST", message: "This request cannot be run" })
      // Claimed first, so a second click or tab cannot run it twice.
      const claimed = await ctx.prisma.agentAction.updateMany({ where: { id: action.id, status: "pending" }, data: { status: "approved", decidedAt: new Date() } })
      if (claimed.count !== 1) throw new TRPCError({ code: "CONFLICT", message: "This request was already decided" })

      const { appRouter } = await import("./index")
      const caller = appRouter.createCaller({ ...ctx, audit: {}, via: apiToken ? "mcp" : "assistant", apiToken })
      let status: "done" | "failed" = "done"
      let result: string | null = null
      let error: string | null = null
      try {
        const reply = await run(caller, JSON.parse(action.input))
        result = JSON.stringify(reply ?? null).slice(0, MAX_RESULT_CHARS)
        const o = outcome(reply)
        if (!o.ok) { status = "failed"; error = o.error ?? null }
      } catch (e) {
        status = "failed"
        error = e instanceof Error ? e.message : String(e)
      }
      // The input can hold a password (a new account): it is not kept once run.
      const done = await ctx.prisma.agentAction.update({ where: { id: action.id }, data: { status, result, error, input: "{}" }, select: shown })
      if (action.conversationId) await tellChat(ctx, action.conversationId, decisionNote({ title: action.title, status, error, result }))
      ctx.audit.success = status === "done"
      return view(done)
    }),

  reject: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const action = await ctx.prisma.agentAction.findUnique({ where: { id: input.id }, select: { userId: true, title: true, conversationId: true } })
      if (!action || action.userId !== ctx.user.userId) throw new TRPCError({ code: "NOT_FOUND" })
      ctx.audit.target = action.title
      const r = await ctx.prisma.agentAction.updateMany({ where: { id: input.id, status: "pending" }, data: { status: "rejected", decidedAt: new Date(), input: "{}" } })
      if (r.count !== 1) throw new TRPCError({ code: "CONFLICT", message: "This request was already decided, or it expired" })
      if (action.conversationId) await tellChat(ctx, action.conversationId, decisionNote({ title: action.title, status: "rejected", error: null, result: null }))
      return { ok: true }
    }),
})
