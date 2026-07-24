import { prisma } from "@app/database"
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify"
import { verifyToken, isTokenBlacklisted, type TokenPayload } from "./auth"

export async function createContext({ req, res }: CreateFastifyContextOptions) {
  let user: TokenPayload | null = null

  const authHeader = req.headers.authorization
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = verifyToken(authHeader.slice(7))
      if (!isTokenBlacklisted(payload.jti)) {
        // The token only proves identity. Admin/user-manager flags are read
        // fresh from the DB on every request, so demoting or deleting an
        // account takes effect immediately instead of when its 7-day token
        // expires.
        const dbUser = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: { isAdmin: true, isUserManager: true },
        })
        if (dbUser) {
          user = {
            userId: payload.userId,
            jti: payload.jti,
            isAdmin: dbUser.isAdmin,
            isUserManager: dbUser.isAdmin || dbUser.isUserManager,
          }
        }
      }
    } catch {
      // invalid token — user stays null
    }
  }

  return { prisma, req, res, user }
}

export type Context = Awaited<ReturnType<typeof createContext>>
