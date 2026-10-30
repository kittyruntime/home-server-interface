import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { router, protectedProcedure, adminProcedure } from "../index"
import { API_SCOPES, DEFAULT_SCOPES, newTokenSecret, parseScopes, tokenUsable } from "../../services/api-tokens"

// Personal access tokens for AI assistants (#138). Signed-in sessions only:
// a token can neither make nor revoke tokens (closedToApiTokens).

const MAX_ACTIVE_TOKENS = 20

const listed = {
  id: true, name: true, prefix: true, scopes: true, expiresAt: true,
  lastUsedAt: true, revokedAt: true, createdAt: true,
} as const

type Listed = { scopes: string; revokedAt: Date | null; expiresAt: Date | null }
const view = <T extends Listed>(t: T) => ({ ...t, scopes: parseScopes(t.scopes), active: tokenUsable(t) })

export const apiTokenRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const tokens = await ctx.prisma.apiToken.findMany({ where: { userId: ctx.user.userId }, select: listed, orderBy: { createdAt: "desc" } })
    return tokens.map(view)
  }),

  // Every account's tokens, for an admin to revoke one.
  listAll: adminProcedure.query(async ({ ctx }) => {
    const tokens = await ctx.prisma.apiToken.findMany({
      where: { revokedAt: null },
      select: { ...listed, user: { select: { username: true } } },
      orderBy: { createdAt: "desc" },
    })
    return tokens.map(view).filter(t => t.active)
  }),

  // The secret is in this reply only: it is never stored nor shown again.
  create: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(64),
      scopes: z.array(z.enum(API_SCOPES)).min(1).default(DEFAULT_SCOPES),
      expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]).nullable().default(90),
    }))
    .mutation(async ({ ctx, input }) => {
      ctx.audit.target = input.name
      const now = new Date()
      const active = await ctx.prisma.apiToken.count({
        where: { userId: ctx.user.userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      })
      if (active >= MAX_ACTIVE_TOKENS) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `At most ${MAX_ACTIVE_TOKENS} active tokens: revoke one first` })
      }
      const { secret, hash, prefix } = newTokenSecret()
      const scopes = [...new Set(input.scopes)]
      const token = await ctx.prisma.apiToken.create({
        data: {
          userId: ctx.user.userId, name: input.name, tokenHash: hash, prefix,
          scopes: JSON.stringify(scopes),
          expiresAt: input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * 86_400_000) : null,
        },
        select: listed,
      })
      return { ...view(token), secret }
    }),

  // Your own tokens; an admin may revoke anyone's.
  revoke: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const token = await ctx.prisma.apiToken.findUnique({ where: { id: input.id }, select: { userId: true, name: true, revokedAt: true } })
      if (!token || (token.userId !== ctx.user.userId && !ctx.user.isAdmin)) throw new TRPCError({ code: "NOT_FOUND" })
      ctx.audit.target = token.name
      if (!token.revokedAt) await ctx.prisma.apiToken.update({ where: { id: input.id }, data: { revokedAt: new Date() } })
      return { ok: true }
    }),
})
