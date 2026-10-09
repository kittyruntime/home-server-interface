import { z } from "zod"
import { router, publicProcedure, adminProcedure } from "../index"
import { requestSync } from "../../nats"
import { signToken } from "../auth"
import { reLinuxUsername } from "../../services/user.service"
import { setupStatus, checkSetupToken, recordProgress, createFirstAdmin, SETUP_STEPS, type SetupDeps, type SetupStep } from "../../services/setup"
import { createUserThroughPlan } from "./user"
import type { Context } from "../context"

// First-run setup assistant (#12): public while no administrator exists,
// then the usual admin authentication.

function deps(ctx: Context): SetupDeps {
  return {
    adminCount: () => ctx.prisma.user.count({ where: { isAdmin: true } }),
    workerVerify: async token => (await requestSync<{ ok: boolean }>("root.setup.verify", { token }, 10_000)).ok,
    getState: async () => {
      // A database restored from a backup older than the setup assistant has
      // no SetupState table until the next update: setup is then finished.
      const s = await ctx.prisma.setupState.findUnique({ where: { id: 1 } }).catch(() => null)
      return s ? { step: s.step, skipped: s.skipped ? s.skipped.split(",") : [] } : null
    },
    setState: async (step, skipped) => {
      const data = { step, skipped: skipped.join(",") }
      await ctx.prisma.setupState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data })
    },
  }
}

const clientIp = (ctx: Context) => ctx.req.ip ?? ctx.req.headers["x-forwarded-for"]?.toString() ?? "unknown"

export const setupRouter = router({
  status: publicProcedure.query(({ ctx }) => setupStatus(deps(ctx), ctx.user)),

  verifyToken: publicProcedure
    .input(z.object({ token: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => ({ setupToken: await checkSetupToken(deps(ctx), input.token, clientIp(ctx)) })),

  createAdmin: publicProcedure
    .input(z.object({
      setupToken: z.string().min(1),
      username: z.string().regex(
        reLinuxUsername,
        "Username must be lowercase letters, digits, - or _, starting with a letter or _ (max 32) so it can back a Linux/SMB account.",
      ),
      password: z.string().min(6, "Use at least 6 characters").max(128).regex(/^[^\r\n]*$/, "A password cannot contain line breaks"),
    }))
    .mutation(async ({ ctx, input }) => {
      const user = await createFirstAdmin(deps(ctx), u => createUserThroughPlan(ctx, u, { isAdmin: true }), input.setupToken,
        { username: input.username, password: input.password })
      await requestSync("root.setup.consume", {}, 10_000).catch(() => {})
      await ctx.prisma.auditLog.create({
        data: { userId: user.id, action: "setup.createAdmin", target: input.username, ip: clientIp(ctx), success: true },
      }).catch(() => {})
      return { token: signToken(user.id, true, false, [], false) }
    }),

  identity: adminProcedure.query(() =>
    requestSync<{ hostname: string; timezone: string; timezones: string[] }>("root.system.identity", {}, 10_000)),

  progress: adminProcedure
    .input(z.object({ step: z.enum(SETUP_STEPS), skip: z.enum(SETUP_STEPS).optional() }))
    .mutation(({ ctx, input }) => recordProgress(deps(ctx), input.step as SetupStep, input.skip)),
})
