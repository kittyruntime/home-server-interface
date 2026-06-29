import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, publicProcedure, protectedProcedure } from "../index"
import { blacklistToken } from "../auth"
import { loginUser } from "../../services/auth.service"

export const authRouter = router({
  login: publicProcedure
    .input(z.object({
      username: z.string().min(1).max(64),
      password: z.string().min(1).max(128),
    }))
    .mutation(async ({ ctx, input }) => {
      const ip = ctx.req.ip ?? ctx.req.headers["x-forwarded-for"]?.toString()
      let userId: string | null = null
      try {
        const user = await ctx.prisma.user.findUnique({
          where: { username: input.username },
          select: { id: true },
        })
        userId = user?.id ?? null
        const result = await loginUser(ctx.prisma, input.username, input.password)
        void ctx.prisma.auditLog.create({
          data: { userId, action: "auth.login", target: input.username, ip, success: true },
        }).catch(() => {})
        return result
      } catch (err) {
        void ctx.prisma.auditLog.create({
          data: { userId, action: "auth.login", target: input.username, ip, success: false },
        }).catch(() => {})
        throw err
      }
    }),

  logout: protectedProcedure
    .mutation(({ ctx }) => {
      blacklistToken(ctx.user.jti)
      return { ok: true }
    }),
})
