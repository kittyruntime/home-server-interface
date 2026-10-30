import crypto from "node:crypto"
import { prisma } from "@app/database"
import type { TokenPayload } from "../trpc/auth"
import { loadCurrentUserAuthorization } from "../utils/request-auth"

// Personal access tokens (#138): an AI assistant connected over MCP acts as
// the token's user. Scopes only narrow what the user may do: every call still
// goes through the user's own rights, rechecked on each request.

export const TOKEN_PREFIX = "hsi_pat_"

export const API_SCOPES = [
  "files:read", "files:write",
  "apps:read", "apps:write",
  "storage:read", "storage:write",
  "users:read", "users:write",
  "system:read", "system:write",
] as const
export type ApiScope = (typeof API_SCOPES)[number]

/** A new token: read-only on everything, unless the user picks otherwise. */
export const DEFAULT_SCOPES: ApiScope[] = API_SCOPES.filter(s => s.endsWith(":read"))

export interface ApiTokenAuth {
  id: string
  scopes: ApiScope[]
}

export type TokenUser = Omit<TokenPayload, "jti"> & { jti: string; apiToken: ApiTokenAuth }

export function hashToken(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex")
}

export function newTokenSecret(): { secret: string; hash: string; prefix: string } {
  const secret = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url")
  return { secret, hash: hashToken(secret), prefix: secret.slice(0, TOKEN_PREFIX.length + 4) }
}

export function parseScopes(raw: string): ApiScope[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)) : []
  } catch {
    return []
  }
}

/** Whether a stored token may be used now. */
export function tokenUsable(t: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()): boolean {
  return !t.revokedAt && (!t.expiresAt || t.expiresAt > now)
}

// lastUsedAt is written at most once a minute per token.
const LAST_USED_EVERY_MS = 60_000

/**
 * The user behind `Authorization: Bearer hsi_pat_…`, with the rights the
 * account has now (a demoted admin loses them at once), or null. Only the MCP
 * endpoint accepts these tokens.
 */
export async function authenticateApiToken(authorization: string | undefined): Promise<TokenUser | null> {
  if (!authorization?.startsWith("Bearer " + TOKEN_PREFIX)) return null
  const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(authorization.slice(7)) } })
  if (!token || !tokenUsable(token)) return null
  const user = await loadCurrentUserAuthorization(token.userId)
  if (!user) return null
  if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
    void prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => {})
  }
  return {
    userId: token.userId,
    jti: "pat:" + token.id,
    isAdmin: user.isAdmin,
    isUserManager: user.isAdmin || user.isUserManager,
    mustChangePassword: user.mustChangePassword,
    capabilities: user.capabilities.map(c => c.capability),
    apiToken: { id: token.id, scopes: parseScopes(token.scopes) },
  }
}
