import { z } from "zod"
import bcrypt from "bcryptjs"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, userManagerProcedure } from "../index"
import { userSelect, createUser, changePassword, DEFAULT_PASSWORD } from "../../services/user.service"
import { syncSharesBestEffort } from "../../services/sharing.service"

export const userRouter = router({
  list: protectedProcedure.query(({ ctx }) => {
    return ctx.prisma.user.findMany({ select: userSelect, orderBy: { createdAt: "asc" } })
  }),

  me: protectedProcedure.query(({ ctx }) => {
    return ctx.prisma.user.findUniqueOrThrow({
      where: { id: ctx.user.userId },
      select: userSelect,
    })
  }),

  // Lightweight security posture for the current account. Used by the dashboard
  // to nudge users who never changed the seeded default credentials. Kept out of
  // `me` (which is polled elsewhere) because the bcrypt compare is deliberate CPU
  // work — this is fetched once per session. The password hash never leaves the
  // server; only the boolean does.
  securityStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: ctx.user.userId },
      select: { password: true },
    })
    return { usingDefaultPassword: await bcrypt.compare(DEFAULT_PASSWORD, user.password) }
  }),

  create: userManagerProcedure
    .input(z.object({
      username: z.string().min(1).max(64),
      password: z.string().min(6).max(128),
      displayName: z.string().max(64).optional(),
    }))
    .mutation(({ ctx, input }) => createUser(ctx.prisma, input)),

  update: userManagerProcedure
    .input(z.object({
      userId: z.string(),
      displayName: z.string().max(64).nullable().optional(),
      linuxUsername: z.string().max(64).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.prisma.user.findUnique({ where: { id: input.userId } })
      if (!target) throw new TRPCError({ code: "NOT_FOUND" })
      const targetIsAdmin = (await ctx.prisma.userRole.findMany({
        where: { userId: input.userId },
        include: { role: { select: { isAdmin: true } } },
      })).some(ur => ur.role.isAdmin)
      if (targetIsAdmin && !ctx.user.isAdmin)
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot edit admin users" })
      const result = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: {
          ...(input.displayName  !== undefined && { displayName:  input.displayName }),
          ...(input.linuxUsername !== undefined && { linuxUsername: input.linuxUsername }),
        },
        select: userSelect,
      })
      if (input.linuxUsername !== undefined) void syncSharesBestEffort(ctx.prisma)
      return result
    }),

  updateSelf: protectedProcedure
    .input(z.object({
      displayName: z.string().max(64).nullable().optional(),
    }))
    .mutation(({ ctx, input }) => {
      return ctx.prisma.user.update({
        where: { id: ctx.user.userId },
        data: { ...(input.displayName !== undefined && { displayName: input.displayName }) },
        select: userSelect,
      })
    }),

  changePassword: protectedProcedure
    .input(z.object({
      currentPassword: z.string(),
      newPassword: z.string().min(6).max(128),
    }))
    .mutation(({ ctx, input }) =>
      changePassword(ctx.prisma, ctx.user.userId, input.currentPassword, input.newPassword)
    ),

  delete: userManagerProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.userId)
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot delete your own account" })
      const target = await ctx.prisma.user.findUnique({ where: { id: input.userId } })
      if (!target) throw new TRPCError({ code: "NOT_FOUND" })
      const targetIsAdmin = (await ctx.prisma.userRole.findMany({
        where: { userId: input.userId },
        include: { role: { select: { isAdmin: true } } },
      })).some(ur => ur.role.isAdmin)
      if (targetIsAdmin && !ctx.user.isAdmin)
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot delete admin users" })
      const result = await ctx.prisma.user.delete({ where: { id: input.userId } })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),
})
