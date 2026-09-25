import { z } from "zod"
import { router, storageProcedure } from "../index"
import { dispatchEvent, type Severity } from "../../services/notifications"

const DEFAULT_THRESHOLDS = { diskUsageWarningPercent: 80, diskUsageCriticalPercent: 90 }

type AlertRow = { source: string; target: string; message: string; severity: string }

// Manual clearing removes the alert and notifies rules like an automatic clear.
// If the condition is still true, the next sampler run (every 5 minutes)
// raises it again: clearing is for stale alerts, not for silencing real ones.
async function clearAlerts(rows: AlertRow[], deleteRows: () => Promise<unknown>) {
  await deleteRows()
  const time = new Date().toISOString()
  for (const a of rows) {
    void dispatchEvent({
      type: "alert.cleared", severity: a.severity as Severity, source: a.source, target: a.target,
      message: `${a.message} (cleared manually)`, time,
    })
  }
  return { cleared: rows.length }
}

export const alertRouter = router({
  list: storageProcedure.query(({ ctx }) => ctx.prisma.alert.findMany()),

  clear: storageProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.prisma.alert.findMany({ where: { id: input.id } })
      return clearAlerts(rows, () => ctx.prisma.alert.deleteMany({ where: { id: input.id } }))
    }),

  clearAll: storageProcedure.mutation(async ({ ctx }) => {
    const rows = await ctx.prisma.alert.findMany()
    return clearAlerts(rows, () => ctx.prisma.alert.deleteMany({ where: { id: { in: rows.map(r => r.id) } } }))
  }),

  thresholds: storageProcedure.query(async ({ ctx }) => {
    const row = await ctx.prisma.alertThreshold.findUnique({ where: { id: "default" } })
    return row ?? { id: "default", ...DEFAULT_THRESHOLDS }
  }),

  updateThresholds: storageProcedure
    .input(z.object({
      diskUsageWarningPercent: z.number().int().min(1).max(99),
      diskUsageCriticalPercent: z.number().int().min(1).max(99),
    }).refine(v => v.diskUsageCriticalPercent > v.diskUsageWarningPercent, {
      message: "Critical threshold must be higher than the warning threshold",
    }))
    .mutation(({ ctx, input }) =>
      ctx.prisma.alertThreshold.upsert({
        where:  { id: "default" },
        update: input,
        create: { id: "default", ...input },
      })
    ),
})
