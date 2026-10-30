import type { FastifyReply, FastifyRequest } from "fastify"
import { TRPCError } from "@trpc/server"
import { prisma } from "@app/database"
import { appRouter } from "../trpc/routers/index"
import { workerErrorCode } from "../trpc/index"
import { ACTION_TTL_MS, isQueueable } from "../services/agent-actions"
import type { ApiTokenAuth, TokenUser } from "../services/api-tokens"
import { checkArgs, filterResult, type Exclusions } from "../services/ai-exclusions"
import { READ_TOOLS, type ToolContext, type ToolDef } from "./tools"
import { CHECK_TOOL, WRITE_TOOLS } from "./write-tools"

// What a tool runs with, for an assistant over MCP (an access token) or in the
// built-in chat (a conversation): the tRPC caller as the user, the audit of
// reads, and the queue of changes waiting for the user's approval.

export const ALL_TOOLS: ToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS, CHECK_TOOL]

/** What the assistant is told when a tool fails. */
export function toolErrorPayload(e: unknown) {
  const code = e instanceof TRPCError ? e.code : undefined
  const workerCode = e instanceof TRPCError ? workerErrorCode(e) : undefined
  const message = e instanceof Error ? e.message : String(e)
  return { error: message, ...(code && { code }), ...(workerCode && { workerCode }) }
}

/** A tool's family: the domain of its scope (files, apps, storage, users, system); null for check_request. */
export function toolFamily(t: Pick<ToolDef, "scope" | "anyScope">): string | null {
  const scope = t.scope ?? t.anyScope?.[0]
  return scope ? scope.split(":")[0]! : null
}

/** Runs a tool, refusing what would open a Place closed to AI assistants and clearing it from the result. */
export async function runGuarded(def: ToolDef, args: Record<string, unknown>, ctx: ToolContext, ex: Exclusions): Promise<unknown> {
  checkArgs(args, { changes: !def.scope?.endsWith(":read"), files: toolFamily(def) === "files" }, ex)
  return filterResult(await def.run(args as never, ctx), ex)
}

export type ToolOrigin =
  | { via: "mcp"; apiToken: ApiTokenAuth }
  | { via: "assistant"; conversationId: string }

export function toolContext(req: FastifyRequest, reply: FastifyReply, user: TokenUser, origin: ToolOrigin, tool: string): ToolContext {
  const apiToken = origin.via === "mcp" ? origin.apiToken : null
  const tokenId = apiToken?.id ?? null
  const conversationId = origin.via === "assistant" ? origin.conversationId : null
  const ctx = {
    prisma, req, res: reply, user,
    audit: {} as { meta?: Record<string, unknown>; success?: boolean; target?: string },
    via: origin.via,
    apiToken,
  }
  const audit = (action: string, target?: string) =>
    prisma.auditLog.create({ data: { userId: user.userId, action, target, ip: req.ip, via: origin.via, tokenId } })
  return {
    caller: appRouter.createCaller(ctx),
    user,
    auditRead: (action, target) => { void audit(action, target).catch(() => {}) },
    queue: async change => {
      if (!isQueueable(change.procedure)) throw new Error(`${change.procedure} cannot be queued`)
      const action = await prisma.agentAction.create({
        data: {
          userId: user.userId, tokenId, conversationId, tool, reason: change.reason,
          procedure: change.procedure, input: JSON.stringify(change.input),
          title: change.title.slice(0, 200), preview: JSON.stringify(change.preview), destructive: change.destructive,
          expiresAt: new Date(Date.now() + ACTION_TTL_MS),
        },
      })
      await audit("agentAction.request", action.title).catch(() => {})
      return {
        requestId: action.id, status: "pending" as const,
        message: origin.via === "mcp"
          ? "Waiting for the user to approve or reject it in HSI (the requests panel of the dashboard). Tell them, then follow up with check_request."
          : "Waiting for the user to approve or reject it: the request is shown in this chat. Tell them what it does; you will be told their decision.",
      }
    },
    checkRequest: async id => {
      const a = await prisma.agentAction.findFirst({
        // An assistant follows its own requests only.
        where: { id, userId: user.userId, ...(origin.via === "mcp" ? { tokenId } : { conversationId }) },
        select: { status: true, title: true, result: true, error: true, expiresAt: true, decidedAt: true },
      })
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown request" })
      const status = a.status === "pending" && a.expiresAt <= new Date() ? "expired" : a.status
      let result: unknown = null
      try { result = a.result ? JSON.parse(a.result) : null } catch { /* kept as null */ }
      return { status, title: a.title, decidedAt: a.decidedAt, error: a.error, result }
    },
  }
}
