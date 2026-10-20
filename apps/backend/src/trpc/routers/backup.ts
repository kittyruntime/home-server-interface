import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { adminProcedure, router } from "../index"
import { requestSync } from "../../nats"
import { verifyPassword } from "../../services/user.service"
import type { BackupStatus, RunRecord } from "../../services/backup-status"

// Reads and actions of the versioned backups (#15). Changes (plans, repositories,
// restores) go through the storage plan procedures; the worker holds the state.
const id = z.string().regex(/^[0-9a-f-]{36}$/)
const snapshot = z.string().regex(/^[0-9a-f]{8,64}$/)

export const backupRouter = router({
  status: adminProcedure.query(() => requestSync<BackupStatus>("root.backup.status", {}, 15_000)),

  runs: adminProcedure
    .input(z.object({ kind: z.enum(["runs", "checks", "restores"]), id, limit: z.number().int().min(1).max(200).default(50) }))
    .query(({ input }) => requestSync<RunRecord[]>("root.backup.runs", input, 15_000)),

  runNow: adminProcedure
    .input(z.object({ id }))
    .mutation(({ input }) => requestSync<{ ok: true }>("root.backup.runNow", input, 15_000)),

  checkNow: adminProcedure
    .input(z.object({ id, full: z.boolean().default(false) }))
    .mutation(({ input }) => requestSync<{ ok: true }>("root.backup.checkNow", input, 15_000)),

  snapshots: adminProcedure
    .input(z.object({ repository: id }))
    .query(({ input }) => requestSync<unknown[]>("root.backup.snapshots", input, 120_000)),

  ls: adminProcedure
    .input(z.object({ repository: id, snapshot, path: z.string().min(1).max(4096).startsWith("/") }))
    .query(({ input }) => requestSync<unknown[]>("root.backup.ls", input, 120_000)),

  // Reveals the repository password after a re-authentication; counted by the
  // login rate limiter (see sensitiveCalls).
  password: adminProcedure
    .input(z.object({ repository: id, currentPassword: z.string().min(1).max(1024) }))
    .mutation(async ({ ctx, input }) => {
      if (!(await verifyPassword(ctx.prisma, ctx.user.userId, input.currentPassword)))
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Wrong password" })
      return requestSync<{ password: string }>("root.backup.password", { repository: input.repository }, 15_000)
    }),

  restoreStatus: adminProcedure
    .input(z.object({ runId: id }))
    .query(({ input }) => requestSync<{ progress: { percentDone: number } | null; result: RunRecord | null }>("root.backup.restoreStatus", input, 15_000)),
})
