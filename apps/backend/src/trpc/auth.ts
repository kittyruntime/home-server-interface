import jwt from "jsonwebtoken"
import crypto from "node:crypto"

const DEV_SECRET = "dev-secret"
const isProd = process.env.NODE_ENV === "production"

// In production, refuse to start with a missing or weak signing key rather than
// silently falling back to a public default that would let anyone forge tokens.
if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error(
    "[security] JWT_SECRET must be set to a strong value (>= 32 chars) in production. " +
    "Refusing to start with an insecure signing key. The install script generates one for you.",
  )
}
if (!process.env.JWT_SECRET) {
  console.warn(
    "[security] JWT_SECRET is not set — using an insecure development default. " +
    "Set JWT_SECRET in your environment before deploying to production.",
  )
}

export const JWT_SECRET = process.env.JWT_SECRET ?? DEV_SECRET

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

// ── File access tokens ────────────────────────────────────────────────────────
// Short-lived, single-path-scoped tokens for the `<img>`/`<video>`/download
// URLs that have to carry auth in the query string (can't set an Authorization
// header on those tags). Minted just-in-time via fs.createFileToken, never the
// long-lived session JWT — keeps that 7-day full-account credential out of
// URLs, browser history, and server access logs.
export interface FileTokenPayload {
  userId: string
  isAdmin: boolean
  path: string
  scope: "file-read"
}

export function signFileToken(userId: string, isAdmin: boolean, path: string): string {
  return jwt.sign({ userId, isAdmin, path, scope: "file-read" }, JWT_SECRET, { expiresIn: "15m" })
}

export function verifyFileToken(token: string): FileTokenPayload {
  const payload = jwt.verify(token, JWT_SECRET) as FileTokenPayload
  if (payload.scope !== "file-read") throw new Error("Invalid token scope")
  return payload
}

// ── Wallpaper image tokens ───────────────────────────────────────────────────
// Same rationale as the file-read tokens above: the desktop background's
// CSS background-image URL can't carry an Authorization header, so a
// short-lived token scoped to "this user's wallpaper, nothing else" is
// minted on demand instead of putting the session JWT in that URL.
export interface WallpaperTokenPayload {
  userId: string
  scope: "wallpaper-read"
}

export function signWallpaperToken(userId: string): string {
  return jwt.sign({ userId, scope: "wallpaper-read" }, JWT_SECRET, { expiresIn: "15m" })
}

export function verifyWallpaperToken(token: string): WallpaperTokenPayload {
  const payload = jwt.verify(token, JWT_SECRET) as WallpaperTokenPayload
  if (payload.scope !== "wallpaper-read") throw new Error("Invalid token scope")
  return payload
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
