import crypto from "node:crypto"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { composeBindSources } from "@app/compose"
import { CATALOG } from "@app/app-catalog"
import { router, adminProcedure } from "../index"
import type { Context } from "../context"
import { publishJob, requestSync } from "../../nats"
import { removeStackDir, stackFilePath, writeStack } from "../../services/containerStacks"
import { assertDockerReady } from "../../services/docker-status"
import { assertVolumeAvailable } from "../../services/volume-guard"
import { planAuditMeta } from "../../services/storage-plan"
import {
  APP_OPS, appAuditInput, appFingerprint, buildAppPlan, executeAppPlan, publicSteps,
  type AppOp, type AppPlan, type AppPlanDeps,
} from "../../services/app-plan"

function deps(ctx: Context, userId: string): AppPlanDeps {
  return {
    stackPath: stackFilePath,
    readStack: async name => {
      try { return await readFile(stackFilePath(name), "utf8") } catch { return null }
    },
    findPlace:   id => ctx.prisma.place.findUnique({ where: { id }, select: { id: true, name: true, path: true } }),
    placeAtPath: async path => (await ctx.prisma.place.findFirst({ where: { path } })) !== null,
    catalog:     id => CATALOG.find(m => m.id === id),
    secret:      () => crypto.randomBytes(24).toString("base64url"),
    effects: {
      writeStack:     async (name, yaml) => { await writeStack(name, yaml) },
      removeStackDir,
      // No path-containment check on root.fs.mkdirp: admin only, as the
      // catalog install it replaces.
      mkdirp:         async path => { await requestSync("root.fs.mkdirp", { path }) },
      createPlace:    async (name, path) => (await ctx.prisma.place.create({ data: { name, path } })).id,
      validate:       async name => { await requestSync("root.container.composeValidate", { name }, 30_000) },
      publishJob:     (action, payload) => publishJob(action, payload, userId),
    },
  }
}

// Checks that are not part of the plan: Docker must be usable, and an app
// bind-mounting a path on a missing volume must not start (#3).
async function preconditions(plan: AppPlan): Promise<void> {
  await assertDockerReady()
  if (plan.op === "app.apply" || plan.op === "app.start") {
    await assertVolumeAvailable(composeBindSources(plan.observed.content ?? ""))
  }
}

const zOp = z.enum(APP_OPS as unknown as [AppOp, ...AppOp[]])

// Operation plans for apps (#36): preview what a change to an app will do,
// then apply exactly that plan.
export const appsRouter = router({
  plan: adminProcedure
    .input(z.object({ op: zOp, input: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      ctx.audit.meta = { input: appAuditInput(input) }
      const plan = await buildAppPlan(input.op, input.input, deps(ctx, ctx.user.userId))
      if (plan.op !== "app.save") await preconditions(plan)
      return { steps: publicSteps(plan), fingerprint: appFingerprint(plan, input.input) }
    }),

  apply: adminProcedure
    .input(z.object({ op: zOp, input: z.unknown(), fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      ctx.audit.meta = { input: appAuditInput(input) }
      const plan = await buildAppPlan(input.op, input.input, deps(ctx, ctx.user.userId))
      if (appFingerprint(plan, input.input) !== input.fingerprint) {
        throw new TRPCError({ code: "CONFLICT", message: "The app changed since the preview: review the plan again" })
      }
      if (plan.op !== "app.save") await preconditions(plan)
      const res = await executeAppPlan(plan)
      const steps = publicSteps(plan)
      ctx.audit.meta = { input: appAuditInput(input), plan: planAuditMeta(input.op, steps, res.results) }
      ctx.audit.success = res.ok
      const jobId = res.results.find(r => r.jobId)?.jobId
      return { ok: res.ok, error: res.error, steps, results: res.results, reply: { ...plan.reply, ...(jobId ? { jobId } : {}) } }
    }),
})
