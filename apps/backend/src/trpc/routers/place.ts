import { z } from "zod"
import { stat, mkdir } from "node:fs/promises"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"

async function accessiblePlaceIds(
  ctx: { prisma: any; user: { userId: string; isAdmin: boolean } }
): Promise<string[]> {
  const userRoles = await ctx.prisma.userRole.findMany({
    where: { userId: ctx.user.userId },
    select: { roleId: true },
  })
  const roleIds = userRoles.map((r: { roleId: string }) => r.roleId)

  const [userPerms, rolePerms] = await Promise.all([
    ctx.prisma.userPlacePermission.findMany({
      where: { userId: ctx.user.userId, canRead: true },
      select: { placeId: true },
    }),
    roleIds.length > 0
      ? ctx.prisma.rolePlacePermission.findMany({
          where: { roleId: { in: roleIds }, canRead: true },
          select: { placeId: true },
        })
      : Promise.resolve([]),
  ])

  return [
    ...new Set([
      ...userPerms.map((p: { placeId: string }) => p.placeId),
      ...rolePerms.map((p: { placeId: string }) => p.placeId),
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
        const s = await stat(input.path)
        if (!s.isDirectory()) {
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
        await mkdir(input.path, { recursive: true })
      } catch (e: any) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e?.message ?? "Failed to create directory" })
      }
      return { ok: true }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      return ctx.prisma.place.delete({ where: { id: input.id } })
    }),
})

export { accessiblePlaceIds }
