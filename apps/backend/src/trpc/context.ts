import { prisma } from "@brume/database"
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify"
import { verifyToken, isTokenBlacklisted, type TokenPayload } from "./auth"

export async function createContext({ req, res }: CreateFastifyContextOptions) {
  let user: TokenPayload | null = null

  const authHeader = req.headers.authorization
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = verifyToken(authHeader.slice(7))
      if (!isTokenBlacklisted(payload.jti)) {
        user = payload
      }
    } catch {
      // invalid token — user stays null
    }
  }

  return { prisma, req, res, user }
}

export type Context = Awaited<ReturnType<typeof createContext>>
