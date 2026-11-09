import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"
import { readJobLogs } from "../../services/jobLogs"
import { requestSync } from "../../nats"
import type { BackupStatus } from "../../services/backup-status"
import { readUpdateAttempt } from "../../services/update-watch"
import { updateStateDir } from "./update"
import {
  HIDDEN_ACTIONS, HISTORY_DAYS, HISTORY_PAGE, isListed, redactSystem, jobWhere, systemTasks, toHistoryView, toTaskView,
  type JobRow, type TaskHistoryView, type TaskView,
} from "../../services/activity"

const JOB_FIELDS = {
  id: true, status: true, action: true, userId: true, meta: true, error: true,
  createdAt: true, startedAt: true, finishedAt: true, cancelledAt: true,
} as const

async function usernamesOf(prisma: any, rows: JobRow[], viewerId: string): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map(r => r.userId).filter((id): id is string => !!id && id !== viewerId))]
  if (ids.length === 0) return new Map()
  const users: Array<{ id: string; username: string }> = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } })
  return new Map(users.map(u => [u.id, u.username]))
}

// Backups are optional (no engine, worker busy): the panel lists jobs anyway.
async function backupStatusOrNull(): Promise<BackupStatus | null> {
  try {
    return await requestSync<BackupStatus>("root.backup.status", {}, 3_000)
  } catch {
    return null
  }
}

export const tasksRouter = router({
  // Background work running now, oldest first.
  list: protectedProcedure.query(async ({ ctx }): Promise<{ running: TaskView[] }> => {
    const viewer = { userId: ctx.user.userId, isAdmin: !!ctx.user.isAdmin }
    const rows: JobRow[] = await ctx.prisma.job.findMany({
      where: { AND: [jobWhere(viewer), { status: { in: ["pending", "running"] } }] },
      orderBy: { createdAt: "asc" },
      select: JOB_FIELDS,
      take: 200,
    })
    const listed = rows.filter(isListed)
    const usernames = await usernamesOf(ctx.prisma, listed, viewer.userId)
    const [backup, attempt] = await Promise.all([backupStatusOrNull(), readUpdateAttempt(updateStateDir())])
    const running = [...systemTasks(backup, attempt), ...listed.map(j => toTaskView(j, viewer.userId, usernames))]
    return { running: running.map(v => redactSystem(v, viewer.isAdmin)) }
  }),

  // Finished background work of the last days, newest first.
  history: protectedProcedure
    .input(z.object({ cursor: z.string().uuid().optional() }))
    .query(async ({ ctx, input }): Promise<{ items: TaskHistoryView[]; nextCursor: string | null }> => {
      const viewer = { userId: ctx.user.userId, isAdmin: !!ctx.user.isAdmin }
      const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000)
      const rows: JobRow[] = await ctx.prisma.job.findMany({
        where: {
          AND: [jobWhere(viewer), { status: { in: ["completed", "failed"] } }, { updatedAt: { gte: since } },
            { action: { notIn: HIDDEN_ACTIONS } }],
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: JOB_FIELDS,
        take: HISTORY_PAGE + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      })
      const page = rows.slice(0, HISTORY_PAGE)
      const nextCursor = rows.length > HISTORY_PAGE ? page[page.length - 1]!.id : null
      const listed = page.filter(isListed)
      const usernames = await usernamesOf(ctx.prisma, listed, viewer.userId)
      return { items: listed.map(j => redactSystem(toHistoryView(j, viewer.userId, usernames), viewer.isAdmin)), nextCursor }
    }),

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
