import { z } from "zod"
import { router, adminProcedure } from "../index"
import { syncSharesBestEffort } from "../../services/sharing.service"

const SubjectType = z.enum(["user", "group"])

export const permissionRouter = router({
  /** Returns all permissions for a place, normalised to a common shape. */
  listForPlace: adminProcedure
    .input(z.object({ placeId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [groupPerms, userPerms] = await Promise.all([
        ctx.prisma.groupPlacePermission.findMany({ where: { placeId: input.placeId } }),
        ctx.prisma.userPlacePermission.findMany({ where: { placeId: input.placeId } }),
      ])
      return [
        ...groupPerms.map((p) => ({ ...p, subjectType: "group" as const, subjectId: p.groupId })),
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
        input.subjectType === "group"
          ? await ctx.prisma.groupPlacePermission.upsert({
              where: { groupId_placeId: { groupId: input.subjectId, placeId: input.placeId } },
              update: { canRead: input.canRead, canWrite: input.canWrite, canDelete: input.canDelete, canShare: input.canShare },
              create: {
                groupId: input.subjectId,
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
        input.subjectType === "group"
          ? await ctx.prisma.groupPlacePermission.deleteMany({
              where: { groupId: input.subjectId, placeId: input.placeId },
            })
          : await ctx.prisma.userPlacePermission.deleteMany({
              where: { userId: input.subjectId, placeId: input.placeId },
            })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),
})
