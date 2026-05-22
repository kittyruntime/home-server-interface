import jwt from "jsonwebtoken"
import crypto from "node:crypto"

if (!process.env.JWT_SECRET) {
  console.warn(
    "[security] JWT_SECRET is not set — using insecure default. " +
    "Set JWT_SECRET in your environment before deploying to production.",
  )
}

export const JWT_SECRET = process.env.JWT_SECRET ?? "brume-dev-secret"

export interface TokenPayload {
  userId: string
  isAdmin: boolean
  canManageUsers: boolean
  jti: string
}

export function signToken(userId: string, isAdmin: boolean, canManageUsers: boolean): string {
  const jti = crypto.randomUUID()
  return jwt.sign({ userId, isAdmin, canManageUsers, jti }, JWT_SECRET, { expiresIn: "7d" })
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload
}

// ── In-memory token blacklist ─────────────────────────────────────────────────
// Holds JTIs of logged-out tokens until they expire.
// Lost on restart — acceptable since restarts already invalidate all jobs.

const blacklist = new Set<string>()

export function blacklistToken(jti: string): void {
  blacklist.add(jti)
}

export function isTokenBlacklisted(jti: string): boolean {
  return blacklist.has(jti)
}

/**
 * Glob-style permission matching.
 * Supported wildcards: `*.*` (all), `ns.*` (all actions in namespace).
 * Example: hasPermission(["users.*"], "users.manage") === true
 */
export function hasPermission(grants: string[], required: string): boolean {
  const [reqNs] = required.split(".")
  return grants.some(g => {
    if (g === required) return true
    if (g === "*.*") return true
    const [ns, action] = g.split(".")
    if (ns === reqNs && action === "*") return true
    return false
  })
}
