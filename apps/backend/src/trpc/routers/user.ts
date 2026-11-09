import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, userManagerProcedure, adminProcedure, CAPABILITIES } from "../index"
import { userSelect, changePassword, reLinuxUsername, getIdentityStatus, assertCreatable, createUserRecord } from "../../services/user.service"
import { requestSync } from "../../nats"
import { desiredShareDefs, syncPlaceAccess, withShareLock } from "../../services/sharing.service"
import { planAuditMeta } from "../../services/storage-plan"
import {
  USER_OPS, applyUserCreate, applyUserDelete, previewUserCreate, previewUserDelete,
  type UserOp, type UserPlanDeps,
} from "../../services/user-plan"
import type { Context } from "../context"
import { syncSharesBestEffort } from "../../services/sharing.service"
import { signToken } from "../auth"

// Per-account UI preferences, synced across a user's browsers/devices. Kept to the
// cross-device-meaningful prefs (theme/accent/sidebar order); device-specific ones
// like desktop mode stay in localStorage. Stored as a JSON blob on the user row.
const zPreferences = z.object({
  theme:        z.enum(["auto", "light", "dark"]).optional(),
  accent:       z.enum(["orange", "blue", "green", "purple"]).optional(),
  sidebarOrder: z.array(z.string()).optional(),
  locale:       z.enum(["en", "fr"]).optional(),
  confirmFileDelete: z.boolean().optional(),
  appearance: z.object({
    theme: z.string().max(32).optional().catch(undefined),
    accent: z.string().max(16).optional().catch(undefined),
    radius: z.number().int().min(0).max(4).optional().catch(undefined),
    density: z.string().max(16).optional().catch(undefined),
  }).optional().catch(undefined),
  // File manager display (#196). Each field falls back on its own, so one bad
  // value never drops the others.
  fileManager: z.object({
    sortField: z.enum(["name", "modified", "size", "type"]).optional().catch(undefined),
    sortDir: z.enum(["asc", "desc"]).optional().catch(undefined),
    columns: z.array(z.enum(["size", "modified", "type"])).max(3).optional().catch(undefined),
    showHidden: z.boolean().optional().catch(undefined),
    view: z.enum(["list", "grid"]).optional().catch(undefined),
    // Bookmarked folders (#199), in the user's order.
    bookmarks: z.array(z.object({
      path: z.string().min(1).max(4096),
      label: z.string().max(64).optional(),
    })).max(50).optional().catch(undefined),
  }).optional().catch(undefined),
})
type Prefs = z.infer<typeof zPreferences>

export function parsePrefs(v: unknown): Prefs {
  const r = zPreferences.safeParse(v ?? {})
  return r.success ? r.data : {}
}

export function mergePrefs(stored: Prefs, input: Prefs): Prefs {
  const defined = <T extends object>(value: T): Partial<T> =>
    Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>

  const merged: Prefs = { ...stored, ...defined(input) }
  if (input.appearance !== undefined) {
    merged.appearance = { ...stored.appearance, ...defined(input.appearance) }
  }
  if (input.fileManager !== undefined) {
    merged.fileManager = { ...stored.fileManager, ...defined(input.fileManager) }
  }
  return merged
}

const zCreateInput = z.object({
  username: z.string().regex(
    reLinuxUsername,
    "Username must be lowercase letters, digits, - or _, starting with a letter or _ (max 32) so it can back a Linux/SMB account.",
  ),
  password: z.string().min(6).max(128).regex(/^[^\r\n]*$/, "A password cannot contain line breaks"),
  displayName: z.string().max(64).optional(),
})
const zDeleteInput = z.object({ userId: z.string() })

function parsed<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input)
  if (!r.success) throw new TRPCError({ code: "BAD_REQUEST", message: r.error.issues[0]?.message ?? "Invalid input" })
  return r.data
}

type Caller = { userId: string; isAdmin: boolean }

// Today's checks for a planned user change, and what the plan needs.
async function prepareUserPlan(ctx: Context, caller: Caller, op: UserOp, raw: unknown, timeout: number) {
  const deps = (username: string, commit: () => Promise<unknown>): UserPlanDeps => ({
    worker: <T>(subject: string, payload: Record<string, unknown>) => requestSync<T>(subject, payload, timeout),
    smbdInstalled: () => requestSync<{ smbdInstalled: boolean }>("root.sharing.checkPrereqs", {}).then(r => r.smbdInstalled),
    shareDefs: () => desiredShareDefs(ctx.prisma, undefined, { withoutUser: username }),
    currentShareDefs: () => desiredShareDefs(ctx.prisma),
    serialize: withShareLock,
    resync: () => syncSharesBestEffort(ctx.prisma),
    commit,
  })
  if (op === "user.create") {
    const input = parsed(zCreateInput, raw)
    // The first administrator (#12) is created as such in the same write, so
    // no non-admin account is left if a later step fails.
    const isAdmin = (raw as { isAdmin?: unknown }).isAdmin === true && caller.userId === ""
    await assertCreatable(ctx.prisma, input.username)
    let created: unknown = null
    const d = deps(input.username, async () => { created = await createUserRecord(ctx.prisma, input, { isAdmin }) })
    // New users have Samba enabled by default (sambaEnabled).
    const planInput = { username: input.username, password: input.password, samba: true }
    return {
      username: input.username,
      preview: () => previewUserCreate(planInput, d),
      apply: async (fp: string) => ({ res: await applyUserCreate(planInput, fp, d), reply: { user: created } }),
    }
  }
  const input = parsed(zDeleteInput, raw)
  if (input.userId === caller.userId)
    throw new TRPCError({ code: "FORBIDDEN", message: "You cannot delete your own account" })
  const target = await ctx.prisma.user.findUnique({ where: { id: input.userId }, select: { isAdmin: true, username: true } })
  if (!target) throw new TRPCError({ code: "NOT_FOUND" })
  if (target.isAdmin && !caller.isAdmin)
    throw new TRPCError({ code: "FORBIDDEN", message: "Cannot delete admin users" })
  const d = deps(target.username, async () => {
    // Their task notifications go with them (no foreign key to cascade).
    await ctx.prisma.$transaction([
      ctx.prisma.notification.deleteMany({ where: { userId: input.userId } }),
      ctx.prisma.user.delete({ where: { id: input.userId } }),
    ])
    void syncPlaceAccess(ctx.prisma).catch(() => {})
  })
  return {
    username: target.username,
    preview: () => previewUserDelete(target.username, d),
    apply: async (fp: string) => ({ res: await applyUserDelete(target.username, fp, d), reply: {} }),
  }
}

/**
 * Creates a user through the same plan as the Users page (Linux account,
 * Samba password, hsi-share group), without a review dialog: used by the
 * first-run setup (#12) for the administrator.
 */
export async function createUserThroughPlan(ctx: Context, input: { username: string; password: string }, flags: { isAdmin?: boolean } = {}) {
  const p = await prepareUserPlan(ctx, { userId: "", isAdmin: true }, "user.create", { ...input, ...flags }, 180_000)
  const preview = await p.preview()
  const { res, reply } = await p.apply(preview.fingerprint)
  if (!res.ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: res.error ?? "Could not create the account" })
  const user = (reply as { user?: { id: string; username: string } | null }).user
  if (!user) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The account was created on the server but not recorded in HSI" })
  return user
}

export const userRouter = router({
  // Operation plans (#36): preview the Linux/Samba account commands of a user
  // creation or deletion, then apply exactly that plan.
  plan: userManagerProcedure
    .input(z.object({ op: z.enum(USER_OPS), input: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const p = await prepareUserPlan(ctx, ctx.user, input.op, input.input, 60_000)
      ctx.audit.target = p.username
      return p.preview()
    }),

  execute: userManagerProcedure
    .input(z.object({ op: z.enum(USER_OPS), input: z.unknown(), fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const p = await prepareUserPlan(ctx, ctx.user, input.op, input.input, 180_000)
      ctx.audit.target = p.username
      const { res, reply } = await p.apply(input.fingerprint)
      ctx.audit.meta = { plan: planAuditMeta(input.op, res.steps, res.results) }
      ctx.audit.success = res.ok
      return { ...res, reply }
    }),

  list: protectedProcedure.query(({ ctx }) => {
    return ctx.prisma.user.findMany({ select: userSelect, orderBy: { createdAt: "asc" } })
  }),

  preferences: protectedProcedure.query(async ({ ctx }) => {
    const u = await ctx.prisma.user.findUnique({
      where: { id: ctx.user.userId },
      select: { preferences: true },
    })
    return parsePrefs(u?.preferences)
  }),

  updatePreferences: protectedProcedure
    .input(zPreferences)
    .mutation(async ({ ctx, input }) => {
      const u = await ctx.prisma.user.findUnique({
        where: { id: ctx.user.userId },
        select: { preferences: true },
      })
      const merged = mergePrefs(parsePrefs(u?.preferences), input)
      await ctx.prisma.user.update({
        where: { id: ctx.user.userId },
        data:  { preferences: merged },
      })
      return merged
    }),

  me: protectedProcedure.query(({ ctx }) => {
    return ctx.prisma.user.findUniqueOrThrow({
      where: { id: ctx.user.userId },
      select: userSelect,
    })
  }),

  update: userManagerProcedure
    .input(z.object({
      userId: z.string(),
      displayName: z.string().max(64).nullable().optional(),
      isAdmin: z.boolean().optional(),
      isUserManager: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { isAdmin: true },
      })
      if (!target) throw new TRPCError({ code: "NOT_FOUND" })
      if (target.isAdmin && !ctx.user.isAdmin)
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot edit admin users" })
      if ((input.isAdmin !== undefined || input.isUserManager !== undefined) && !ctx.user.isAdmin)
        throw new TRPCError({ code: "FORBIDDEN" })
      // An admin may not strip their own admin flag: the UI disables this, but
      // a direct API call could otherwise lock out the last administrator.
      if (input.isAdmin === false && input.userId === ctx.user.userId)
        throw new TRPCError({ code: "FORBIDDEN", message: "You can't remove your own admin access" })
      const result = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: {
          ...(input.displayName    !== undefined && { displayName:    input.displayName }),
          ...(input.isAdmin        !== undefined && { isAdmin:        input.isAdmin }),
          ...(input.isUserManager  !== undefined && { isUserManager:  input.isUserManager }),
        },
        select: userSelect,
      })
      if (input.isAdmin !== undefined || input.isUserManager !== undefined)
        void syncSharesBestEffort(ctx.prisma)
      return result
    }),

  updateSelf: protectedProcedure
    .input(z.object({
      displayName: z.string().max(64).nullable().optional(),
    }))
    .mutation(({ ctx, input }) => {
      return ctx.prisma.user.update({
        where: { id: ctx.user.userId },
        data: { ...(input.displayName !== undefined && { displayName: input.displayName }) },
        select: userSelect,
      })
    }),

  changePassword: protectedProcedure
    .input(z.object({
      currentPassword: z.string(),
      newPassword: z.string().min(6).max(128),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await changePassword(ctx.prisma, ctx.user.userId, input.currentPassword, input.newPassword)
      // ctx.user's existing claims are still valid post-change (only the password
      // moved): re-sign rather than re-query, so a forced change unblocks the
      // account immediately instead of waiting for the next login.
      const token = signToken(ctx.user.userId, ctx.user.isAdmin, ctx.user.isUserManager, ctx.user.capabilities, false)
      return { ...result, token }
    }),

  // Real Linux/Samba account state per user, alongside what HSI expects (see
  // user.service.ts's getIdentityStatus for the reconciliation rule).
  identityStatus: userManagerProcedure.query(({ ctx }) => getIdentityStatus(ctx.prisma)),

  setSambaEnabled: userManagerProcedure
    .input(z.object({ userId: z.string(), sambaEnabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.prisma.user.findUnique({ where: { id: input.userId }, select: { isAdmin: true } })
      if (!target) throw new TRPCError({ code: "NOT_FOUND" })
      if (target.isAdmin && !ctx.user.isAdmin)
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot edit admin users" })
      return ctx.prisma.user.update({
        where: { id: input.userId },
        data: { sambaEnabled: input.sambaEnabled },
        select: userSelect,
      })
    }),

  setCapability: adminProcedure
    .input(z.object({
      userId: z.string(),
      capability: z.enum(CAPABILITIES),
      granted: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      })
      if (!target) throw new TRPCError({ code: "NOT_FOUND" })
      if (input.granted) {
        await ctx.prisma.userCapability.upsert({
          where: { userId_capability: { userId: input.userId, capability: input.capability } },
          create: { userId: input.userId, capability: input.capability },
          update: {},
        })
      } else {
        await ctx.prisma.userCapability.deleteMany({
          where: { userId: input.userId, capability: input.capability },
        })
      }
    }),
})
