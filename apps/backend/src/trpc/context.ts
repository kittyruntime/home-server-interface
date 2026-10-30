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
    // Calls made by an AI assistant (#138): over MCP with an access token, or
    // by the built-in chat.
    via: "dashboard" as "dashboard" | "mcp" | "assistant",
    apiToken: null as ApiTokenAuth | null,
  }
}

export type Context = Awaited<ReturnType<typeof createContext>>
