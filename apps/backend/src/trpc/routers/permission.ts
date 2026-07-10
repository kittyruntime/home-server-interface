import { z } from "zod"
import { router, adminProcedure } from "../index"
import { syncSharesBestEffort } from "../../services/sharing.service"

const SubjectType = z.enum(["user", "role"])

export const permissionRouter = router({
  /** Returns all permissions for a place, normalised to a common shape. */
  listForPlace: adminProcedure
    .input(z.object({ placeId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [rolePerms, userPerms] = await Promise.all([
        ctx.prisma.rolePlacePermission.findMany({ where: { placeId: input.placeId } }),
        ctx.prisma.userPlacePermission.findMany({ where: { placeId: input.placeId } }),
      ])
      return [
        ...rolePerms.map((p) => ({ ...p, subjectType: "role" as const, subjectId: p.roleId })),
        ...userPerms.map((p) => ({ ...p, subjectType: "user" as const, subjectId: p.userId })),
      ]
    }),

  /** Create or update a permission record. */
  upsert: adminProcedure
    .input(
      z.object({
        placeId: z.string(),
        subjectType: SubjectType,
        subjectId: z.string(),
        canRead: z.boolean(),
        canWrite: z.boolean(),
        canDelete: z.boolean(),
        canShare: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result =
        input.subjectType === "role"
          ? await ctx.prisma.rolePlacePermission.upsert({
              where: { roleId_placeId: { roleId: input.subjectId, placeId: input.placeId } },
              update: { canRead: input.canRead, canWrite: input.canWrite, canDelete: input.canDelete, canShare: input.canShare },
              create: {
                roleId: input.subjectId,
                placeId: input.placeId,
                canRead: input.canRead,
                canWrite: input.canWrite,
                canDelete: input.canDelete,
                canShare: input.canShare,
              },
            })
          : await ctx.prisma.userPlacePermission.upsert({
              where: { userId_placeId: { userId: input.subjectId, placeId: input.placeId } },
              update: { canRead: input.canRead, canWrite: input.canWrite, canDelete: input.canDelete, canShare: input.canShare },
              create: {
                userId: input.subjectId,
                placeId: input.placeId,
                canRead: input.canRead,
                canWrite: input.canWrite,
                canDelete: input.canDelete,
                canShare: input.canShare,
              },
            })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),

  /** Remove a permission record. */
  remove: adminProcedure
    .input(
      z.object({
        placeId: z.string(),
        subjectType: SubjectType,
        subjectId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result =
        input.subjectType === "role"
          ? await ctx.prisma.rolePlacePermission.deleteMany({
              where: { roleId: input.subjectId, placeId: input.placeId },
            })
          : await ctx.prisma.userPlacePermission.deleteMany({
              where: { userId: input.subjectId, placeId: input.placeId },
            })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),
})
