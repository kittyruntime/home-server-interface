import { TRPCError, initTRPC } from "@trpc/server"
import type { Context } from "./context"
import { currentMaintenance } from "../services/maintenance"

/**
 * The root-worker's code of a failed request (EPASSWORD, ECONFIRM...), carried by the
 * error requestSync throws. The dashboard reads it from the error data instead of
 * matching messages.
 */
export function workerErrorCode(error: { cause?: unknown }): string | undefined {
  const code = (error.cause as { code?: unknown } | undefined)?.code
  return typeof code === "string" && /^E[A-Z]{2,15}$/.test(code) ? code : undefined
}

const t = initTRPC.context<Context>().create({
  errorFormatter: ({ shape, error }) => ({ ...shape, data: { ...shape.data, workerCode: workerErrorCode(error) } }),
})

export const router = t.router
export const publicProcedure = t.procedure

// What an AI assistant, over MCP with an access token (#138) or in the built-in
// chat, may never reach: making or revoking tokens, approving its own
// requests, its own settings, the password, signing in and out, the first-run
// setup.
export function closedToApiTokens(path: string): boolean {
  return path.startsWith("apiToken.") || path.startsWith("agentAction.") || path.startsWith("assistant.") ||
    path.startsWith("auth.") || path.startsWith("setup.") || path === "user.changePassword"
}

const isAuthed = t.middleware(({ ctx, path, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" })
  }
  if ((ctx.apiToken || ctx.via === "assistant") && closedToApiTokens(path)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Not available to an AI assistant." })
  }
  return next({ ctx: { user: ctx.user } })
})

// A user with mustChangePassword set (currently: an admin / admin account seeded
// by an install from before the setup assistant, #12) can't perform any mutation except changing their own password or logging
// out, until they do. Queries stay open: the dashboard still needs to load to show
// the change-password screen. Enforced server-side, not just by the UI redirect,
// since the JWT carrying this flag is trusted for its full 7-day life either way.
const EXEMPT_WHILE_MUST_CHANGE_PASSWORD = new Set(["user.changePassword", "auth.logout"])

const blockIfMustChangePassword = t.middleware(({ ctx, path, type, next }) => {
  if (type === "mutation" && ctx.user?.mustChangePassword && !EXEMPT_WHILE_MUST_CHANGE_PASSWORD.has(path)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Change your password before performing this action." })
  }
  return next()
})

// While an update, a restart or a reboot is under way (#132), nothing may
// change the server: the dashboards show a blocking overlay, and this refuses
// what a stale tab or a script would still send. Signing in and out stays open.
const blockDuringMaintenance = t.middleware(async ({ path, type, next }) => {
  if (type === "mutation" && !path.startsWith("auth.") && await currentMaintenance()) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The server is being updated or restarted. Try again once it is back." })
  }
  return next()
})

const isAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user?.isAdmin) {
    throw new TRPCError({ code: "FORBIDDEN" })
  }
  return next()
})

const isUserManager = t.middleware(({ ctx, next }) => {
  if (!ctx.user?.isAdmin && !ctx.user?.isUserManager) {
    throw new TRPCError({ code: "FORBIDDEN" })
  }
  return next()
})

export const CAPABILITIES = ["storage"] as const
export type Capability = (typeof CAPABILITIES)[number]

function hasCapability(capability: Capability) {
  return t.middleware(({ ctx, next }) => {
    if (!ctx.user?.isAdmin && !ctx.user?.capabilities?.includes(capability)) {
      throw new TRPCError({ code: "FORBIDDEN" })
    }
    return next()
  })
}

// ── Audit logging ────────────────────────────────────────────────────────────

export function extractTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  let i = input as Record<string, unknown>
  // Operation plans wrap the operation's input: { op, input, fingerprint }.
  if (typeof i["op"] === "string" && i["input"] && typeof i["input"] === "object") i = i["input"] as Record<string, unknown>
  const v = i["path"] ?? i["device"] ?? i["mountpoint"] ?? i["name"] ??
    i["username"] ?? i["vgName"] ?? i["lvName"] ?? i["id"] ?? i["url"]
  return v != null ? String(v) : undefined
}

/** A procedure can name its target itself (e.g. a share by name, not id). */
export function auditTarget(rawInput: unknown, audit?: { target?: string }): string | undefined {
  return audit?.target ?? extractTarget(rawInput)
}

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|key|auth|credential/i

// A PEM private key block, of any type (RSA, EC, ENCRYPTED...), BEGIN to END, or to the end of the string when truncated.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g

function redact(v: unknown): unknown {
  if (typeof v === "string") return v.includes("PRIVATE KEY-----") ? v.replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]") : v
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>
    // {key, value} entries (env vars, labels…): the secret is in `value`, named by
    // `key`, so redact based on the key's *value*, not the "key"/"value" property
    // names (which would otherwise leave the actual secret in `value` untouched).
    if (typeof rec.key === "string" && "value" in rec) {
      return { ...rec, value: SENSITIVE_KEY.test(rec.key) ? "[REDACTED]" : redact(rec.value) }
    }
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(rec)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(val)
    }
    return out
  }
  return v
}

export const redactForAudit = redact

function sanitizeMeta(input: unknown): string | undefined {
  if (input == null) return undefined
  return JSON.stringify(redact(input))
}

const auditLog = t.middleware(async (opts) => {
  const result = await opts.next()
  if (opts.type === "mutation" && opts.ctx.user) {
    const rawInput = await opts.getRawInput().catch(() => undefined)
    void opts.ctx.prisma.auditLog.create({
      data: {
        userId:  opts.ctx.user.userId,
        action:  opts.path,
        target:  auditTarget(rawInput, opts.ctx.audit),
        meta:    sanitizeMeta(opts.ctx.audit?.meta ? { input: rawInput, ...opts.ctx.audit.meta } : rawInput),
        ip:      opts.ctx.req.ip ?? opts.ctx.req.headers["x-forwarded-for"]?.toString(),
        // A procedure can report a failure it returns as data (e.g. a plan
        // whose step failed).
        success: result.ok && opts.ctx.audit?.success !== false,
        via:     opts.ctx.via,
        tokenId: opts.ctx.apiToken?.id,
      },
    }).catch(() => {})
  }
  return result
})

export const protectedProcedure   = t.procedure.use(isAuthed).use(blockIfMustChangePassword).use(blockDuringMaintenance).use(auditLog)
export const adminProcedure       = t.procedure.use(isAuthed).use(blockIfMustChangePassword).use(blockDuringMaintenance).use(isAdmin).use(auditLog)
export const userManagerProcedure = t.procedure.use(isAuthed).use(blockIfMustChangePassword).use(blockDuringMaintenance).use(isUserManager).use(auditLog)
export const storageProcedure = t.procedure.use(isAuthed).use(blockIfMustChangePassword).use(blockDuringMaintenance).use(hasCapability("storage")).use(auditLog)
