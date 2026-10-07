import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, userManagerProcedure, adminProcedure, CAPABILITIES } from "../index"
import { userSelect, createUser, changePassword, reLinuxUsername, getIdentityStatus, assertCreatable, createUserRecord } from "../../services/user.service"
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
})
function parsePrefs(v: unknown): z.infer<typeof zPreferences> {
  const r = zPreferences.safeParse(v ?? {})
  return r.success ? r.data : {}
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
    await assertCreatable(ctx.prisma, input.username)
    let created: unknown = null
    const d = deps(input.username, async () => { created = await createUserRecord(ctx.prisma, input) })
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
    await ctx.prisma.user.delete({ where: { id: input.userId } })
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
export async function createUserThroughPlan(ctx: Context, input: { username: string; password: string }) {
  const p = await prepareUserPlan(ctx, { userId: "", isAdmin: true }, "user.create", input, 180_000)
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

  apply: userManagerProcedure
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
      const merged = { ...parsePrefs(u?.preferences), ...input }
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

  // Lightweight security posture for the current account. Superseded by
  // ctx.user.mustChangePassword (carried in the JWT, decoded client-side) for the
  // forced-change flow, kept as a query only as a fallback for a token issued
  // before this field existed, or one that's simply gone stale mid-session.
  securityStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: ctx.user.userId },
      select: { mustChangePassword: true },
    })
    return { mustChangePassword: user.mustChangePassword }
  }),

  create: userManagerProcedure
    .input(z.object({
      username: z.string().regex(
        reLinuxUsername,
        "Username must be lowercase letters, digits, - or _, starting with a letter or _ (max 32) so it can back a Linux/SMB account.",
      ),
      password: z.string().min(6).max(128),
      displayName: z.string().max(64).optional(),
    }))
    .mutation(({ ctx, input }) => createUser(ctx.prisma, input)),

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

  delete: userManagerProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.userId)
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot delete your own account" })
      const target = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { isAdmin: true },
      })
      if (!target) throw new TRPCError({ code: "NOT_FOUND" })
      if (target.isAdmin && !ctx.user.isAdmin)
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot delete admin users" })
      const result = await ctx.prisma.user.delete({ where: { id: input.userId } })
      void syncSharesBestEffort(ctx.prisma)
      return result
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
