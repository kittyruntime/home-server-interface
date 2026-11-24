import { isTokenBlacklisted, verifyToken, type TokenPayload } from './auth'

export interface CurrentUserAuthorization {
  isAdmin: boolean
  isUserManager: boolean
  mustChangePassword: boolean
  capabilities: { capability: string }[]
}

export type LoadCurrentUser = (userId: string) => Promise<CurrentUserAuthorization | null>

/**
 * Validate a session bearer token, then rebuild its authorization data from
 * the current database record. Token role/capability claims are deliberately
 * ignored so account deletion and privilege changes take effect immediately.
 *
 * Token errors are authentication failures; database errors are allowed to
 * propagate so an outage is not misreported as an invalid session.
 */
export async function authenticateSession(
  authorization: string | undefined,
  loadCurrentUser: LoadCurrentUser,
): Promise<TokenPayload | null> {
  if (!authorization?.startsWith('Bearer ')) return null

  let payload: TokenPayload
  try {
    payload = verifyToken(authorization.slice(7))
    if (!payload.userId || !payload.jti || isTokenBlacklisted(payload.jti)) return null
  } catch {
    return null
  }

  const user = await loadCurrentUser(payload.userId)
  if (!user) return null

  return {
    userId: payload.userId,
    jti: payload.jti,
    isAdmin: user.isAdmin,
    isUserManager: user.isAdmin || user.isUserManager,
    mustChangePassword: user.mustChangePassword,
    capabilities: user.capabilities.map(item => item.capability),
  }
}
