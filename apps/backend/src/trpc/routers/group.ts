import { z } from "zod"
import { router, adminProcedure } from "../index"
import { syncSharesBestEffort } from "../../services/sharing.service"

export const groupRouter = router({
  list: adminProcedure.query(({ ctx }) =>
    ctx.prisma.group.findMany({
      select: { id: true, name: true, members: { select: { userId: true } } },
      orderBy: { name: "asc" },
    })
  ),

  create: adminProcedure
    .input(z.object({ name: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => ctx.prisma.group.create({ data: { name: input.name } })),

  rename: adminProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => ctx.prisma.group.update({ where: { id: input.id }, data: { name: input.name } })),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Cascade removes the group's GroupPlacePermission rows, so users who had
      // share access only through this group lose it — resync so smb.conf drops
      // them from valid/write lists instead of leaving stale network access.
      const r = await ctx.prisma.group.delete({ where: { id: input.id } })
      void syncSharesBestEffort(ctx.prisma)
      return r
    }),

  setMembers: adminProcedure
    .input(z.object({ id: z.string(), userIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.$transaction([
        ctx.prisma.userGroup.deleteMany({ where: { groupId: input.id } }),
        ctx.prisma.userGroup.createMany({ data: input.userIds.map((userId) => ({ userId, groupId: input.id })) }),
      ])
      void syncSharesBestEffort(ctx.prisma)
      return { ok: true }
    }),
})
