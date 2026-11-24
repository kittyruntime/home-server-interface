import { prisma } from '@app/database'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { authenticateRequest } from '../utils/request-auth'
import type { ApiTokenAuth } from '../services/api-tokens'
import { authenticateWall, type WallAuth } from '../services/dashboard-walls'

export async function createContext({ req, res }: CreateFastifyContextOptions) {
  let user = await authenticateRequest(req)
  // A wall display (its own token kind, accepted only here, on tRPC).
  let wall: WallAuth | null = null
  if (!user) {
    const w = await authenticateWall(req.headers.authorization)
    if (w) { user = w.user; wall = w.wall }
  }

  // audit.meta: extra details a procedure adds to its audit entry (e.g. the
  // executed operation plan).
  return {
    prisma, req, res, user,
    audit: {} as { meta?: Record<string, unknown>; success?: boolean; target?: string },
    // Calls made by an AI assistant (#138): over MCP with an access token, or
    // by the built-in chat.
    via: 'dashboard' as 'dashboard' | 'mcp' | 'assistant',
    apiToken: null as ApiTokenAuth | null,
    wall,
  }
}

export type Context = Awaited<ReturnType<typeof createContext>>
