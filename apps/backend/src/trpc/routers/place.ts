import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"
import { requestSync } from "../../nats"
import { syncSharesBestEffort } from "../../services/sharing.service"

async function accessiblePlaceIds(
  ctx: { prisma: any; user: { userId: string; isAdmin: boolean } }
): Promise<string[]> {
  const userGroups = await ctx.prisma.userGroup.findMany({
    where: { userId: ctx.user.userId },
    select: { groupId: true },
  })
  const groupIds = userGroups.map((g: { groupId: string }) => g.groupId)

  const [userPerms, groupPerms] = await Promise.all([
    ctx.prisma.userPlacePermission.findMany({
      where: { userId: ctx.user.userId, canRead: true },
      select: { placeId: true },
    }),
    groupIds.length > 0
      ? ctx.prisma.groupPlacePermission.findMany({
          where: { groupId: { in: groupIds }, canRead: true },
          select: { placeId: true },
        })
      : Promise.resolve([]),
  ])

  return [
    ...new Set([
      ...userPerms.map((p: { placeId: string }) => p.placeId),
      ...groupPerms.map((p: { placeId: string }) => p.placeId),
    ]),
  ] as string[]
}

export const placeRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.isAdmin) {
      return ctx.prisma.place.findMany({ orderBy: { createdAt: "asc" } })
    }
    const ids = await accessiblePlaceIds(ctx)
    return ctx.prisma.place.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: "asc" },
    })
  }),

  create: adminProcedure
    .input(z.object({ name: z.string().min(1), path: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await requestSync<{ type: string }>("root.fs.stat", { path: input.path })
        if (result.type !== "dir") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Path is not a directory" })
        }
      } catch (e) {
        if (e instanceof TRPCError) throw e
        throw new TRPCError({ code: "BAD_REQUEST", message: "Path does not exist" })
      }

      return ctx.prisma.place.create({ data: { name: input.name, path: input.path } })
    }),

  mkdir: adminProcedure
    .input(z.object({ path: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await requestSync("root.fs.mkdirp", { path: input.path })
      } catch (e: any) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e?.message ?? "Failed to create directory" })
      }
      return { ok: true }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Cascade removes the Place's Share row; the follow-up sync drops it
      // from Samba as well.
      const result = await ctx.prisma.place.delete({ where: { id: input.id } })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),
})

export { accessiblePlaceIds }
