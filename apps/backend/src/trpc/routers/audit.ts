import { z } from "zod"
import { router, adminProcedure } from "../index"

export const auditRouter = router({
  list: adminProcedure
    .input(z.object({
      page:   z.number().int().min(0).default(0),
      limit:  z.number().int().min(1).max(200).default(50),
      userId: z.string().optional(),
      action: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const where = {
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.action ? { action: { contains: input.action } } : {}),
      }
      const [total, entries] = await Promise.all([
        ctx.prisma.auditLog.count({ where }),
        ctx.prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip:  input.page * input.limit,
          take:  input.limit,
          include: {
            user: { select: { username: true, displayName: true } },
          },
        }),
      ])
      return { total, entries }
    }),
})
