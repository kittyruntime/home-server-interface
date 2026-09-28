import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"
import { readJobLogs } from "../../services/jobLogs"

export const tasksRouter = router({
  get: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const job = await ctx.prisma.job.findUnique({ where: { id: input.jobId } })
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" })
      return {
        id:     job.id,
        status: job.status as "pending" | "running" | "completed" | "failed",
        action: job.action,
        result: job.result ? (() => { try { return JSON.parse(job.result!) } catch { return null } })() : null,
        error:  job.error ?? null,
      }
    }),

  // Log lines of one job from the backend and worker logs (admin only: they
  // name users, paths and commands).
  logs: adminProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .query(({ input }) => readJobLogs(input.jobId)),
})
