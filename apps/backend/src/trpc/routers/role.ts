import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure, userManagerProcedure } from "../index"
import { syncSharesBestEffort } from "../../services/sharing.service"

export const roleRouter = router({
  list: protectedProcedure.query(({ ctx }) => {
    return ctx.prisma.role.findMany({
      orderBy: { name: "asc" },
      include: {
        userRoles: { select: { userId: true } },
        permissions: { select: { permission: { select: { name: true } } } },
      },
    })
  }),

  create: adminProcedure
    .input(z.object({ name: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => {
      return ctx.prisma.role.create({ data: { name: input.name } })
    }),

  /** Toggle isAdmin on a role. */
  update: adminProcedure
    .input(z.object({ id: z.string(), isAdmin: z.boolean() }))
    .mutation(({ ctx, input }) => {
      return ctx.prisma.role.update({
        where: { id: input.id },
        data: { isAdmin: input.isAdmin },
      })
    }),

  /**
   * Grant a permission to a role.
   * The Permission record is upserted automatically so callers can use any
   * glob-style name (e.g. "files.*", "users.manage", "*.*").
   */
  addPermission: adminProcedure
    .input(z.object({
      roleId: z.string(),
      permissionName: z.string().min(1).max(128),
    }))
    .mutation(async ({ ctx, input }) => {
      const perm = await ctx.prisma.permission.upsert({
        where: { name: input.permissionName },
        update: {},
        create: { name: input.permissionName },
      })
      return ctx.prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: input.roleId, permissionId: perm.id } },
        update: {},
        create: { roleId: input.roleId, permissionId: perm.id },
      })
    }),

  /** Revoke a permission from a role. */
  removePermission: adminProcedure
    .input(z.object({
      roleId: z.string(),
      permissionName: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const perm = await ctx.prisma.permission.findUnique({ where: { name: input.permissionName } })
      if (!perm) return
      return ctx.prisma.rolePermission.delete({
        where: { roleId_permissionId: { roleId: input.roleId, permissionId: perm.id } },
      })
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Cascade removes the role's RolePlacePermission rows, so users who had
      // share access only through this role lose it — resync so smb.conf drops
      // them from valid/write lists instead of leaving stale network access.
      const result = await ctx.prisma.role.delete({ where: { id: input.id } })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),

  assignUser: userManagerProcedure
    .input(z.object({ userId: z.string(), roleId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.userId)
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot assign roles to yourself" })
      const user = await ctx.prisma.user.findUnique({ where: { id: input.userId } })
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" })
      const role = await ctx.prisma.role.findUnique({ where: { id: input.roleId } })
      if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "Role not found" })
      const result = await ctx.prisma.userRole.upsert({
        where: { userId_roleId: { userId: input.userId, roleId: input.roleId } },
        update: {},
        create: { userId: input.userId, roleId: input.roleId },
      })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),

  removeUser: userManagerProcedure
    .input(z.object({ userId: z.string(), roleId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.userId)
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot remove roles from yourself" })
      const result = await ctx.prisma.userRole.delete({
        where: { userId_roleId: { userId: input.userId, roleId: input.roleId } },
      })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),
})
