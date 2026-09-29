import { prisma } from "@app/database"
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify"
import { authenticateRequest } from "../utils/request-auth"

export async function createContext({ req, res }: CreateFastifyContextOptions) {
  const user = await authenticateRequest(req)

  // audit.meta: extra details a procedure adds to its audit entry (e.g. the
  // executed operation plan).
  return { prisma, req, res, user, audit: {} as { meta?: Record<string, unknown>; success?: boolean } }
}

export type Context = Awaited<ReturnType<typeof createContext>>
