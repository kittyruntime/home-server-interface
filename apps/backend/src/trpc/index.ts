import { TRPCError, initTRPC } from "@trpc/server"
import type { Context } from "./context"
import { hasPermission } from "./auth"

const t = initTRPC.context<Context>().create()

export const router = t.router
export const publicProcedure = t.procedure

const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" })
  }
  return next({ ctx: { user: ctx.user } })
})

const isAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user?.isAdmin) {
    throw new TRPCError({ code: "FORBIDDEN" })
  }
  return next()
})

const isUserManager = t.middleware(({ ctx, next }) => {
  if (!ctx.user?.isAdmin && !ctx.user?.canManageUsers) {
    throw new TRPCError({ code: "FORBIDDEN" })
  }
  return next()
})

// ── Audit logging ────────────────────────────────────────────────────────────

function extractTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const i = input as Record<string, unknown>
  const v = i["path"] ?? i["device"] ?? i["mountpoint"] ?? i["name"] ??
    i["username"] ?? i["vgName"] ?? i["lvName"] ?? i["id"] ?? i["url"]
  return v != null ? String(v) : undefined
}

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|key|auth|credential/i

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>
    // {key, value} entries (env vars, labels…): the secret is in `value`, named by
    // `key` — so redact based on the key's *value*, not the "key"/"value" property
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

function sanitizeMeta(input: unknown): string | undefined {
  if (input == null) return undefined
  return JSON.stringify(redact(input))
}

const auditLog = t.middleware(async (opts) => {
  const result = await opts.next()
  if (opts.type === "mutation" && opts.ctx.user) {
    void opts.ctx.prisma.auditLog.create({
      data: {
        userId:  opts.ctx.user.userId,
        action:  opts.path,
        target:  extractTarget(opts.rawInput),
        meta:    sanitizeMeta(opts.rawInput),
        ip:      opts.ctx.req.ip ?? opts.ctx.req.headers["x-forwarded-for"]?.toString(),
        success: result.ok,
      },
    }).catch(() => {})
  }
  return result
})

export const protectedProcedure   = t.procedure.use(isAuthed).use(auditLog)
export const adminProcedure       = t.procedure.use(isAuthed).use(isAdmin).use(auditLog)
export const userManagerProcedure = t.procedure.use(isAuthed).use(isUserManager).use(auditLog)

/**
 * Returns a middleware that allows admins unconditionally, and checks
 * glob-style permission grants from the DB for other authenticated users.
 * Use as: protectedProcedure.use(withPermission("container.create"))
 */
export function withPermission(required: string) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" })
    if (ctx.user.isAdmin) return next()

    const userRoles = await ctx.prisma.userRole.findMany({
      where: { userId: ctx.user.userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    })
    const grants = userRoles.flatMap(ur =>
      ur.role.permissions.map(rp => rp.permission.name),
    )
    if (!hasPermission(grants, required)) {
      throw new TRPCError({ code: "FORBIDDEN", message: `Missing permission: ${required}` })
    }
    return next()
  })
}
