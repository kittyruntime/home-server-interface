import { prisma } from "@app/database"
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify"
import { authenticateRequest } from "../utils/request-auth"
import type { ApiTokenAuth } from "../services/api-tokens"

export async function createContext({ req, res }: CreateFastifyContextOptions) {
  const user = await authenticateRequest(req)

  // audit.meta: extra details a procedure adds to its audit entry (e.g. the
  // executed operation plan).
  return {
    prisma, req, res, user,
    audit: {} as { meta?: Record<string, unknown>; success?: boolean; target?: string },
    // Set by the MCP endpoint (#138): calls made with an access token.
    via: "dashboard" as "dashboard" | "mcp",
    apiToken: null as ApiTokenAuth | null,
  }
}

export type Context = Awaited<ReturnType<typeof createContext>>
