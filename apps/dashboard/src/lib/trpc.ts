import { createTRPCClient, httpBatchStreamLink, httpLink, splitLink, type TRPCLink } from '@trpc/client'
import { tap } from '@trpc/server/observable'
import type { AppRouter } from '@app/shared-types'

// When a stored session token is rejected (expired or revoked), tear down the
// local session and bounce to the login screen. Guarded on token presence so a
// failed login attempt (which 401s before any token is stored) is left for the
// login form to handle instead of triggering a redirect loop.
function onSessionInvalid(rejectedToken: string) {
  // A request can finish after the user has signed in again. Never remove the
  // newer session in response to an older token's rejection.
  if (localStorage.getItem('token') !== rejectedToken) return
  localStorage.removeItem('token')
  localStorage.removeItem('username')
  // The setup assistant handles its own errors and must keep its link (#12).
  if (window.location.pathname !== '/login' && !window.location.pathname.startsWith('/setup')) {
    // Full navigation, not a router push: guarantees every in-memory store and
    // pending request tied to the dead session is discarded.
    window.location.assign('/login')
  }
}

export const MAINTENANCE_EVENT = 'hsi:maintenance'

function isSessionRejection(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isSessionRejection)
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const error = record.error as { data?: { code?: unknown; sessionInvalid?: unknown } } | undefined
  return error?.data?.code === 'UNAUTHORIZED' && error.data.sessionInvalid === true
}

export function createSessionAwareFetch(
  fetcher: typeof fetch,
  invalidateSession: (rejectedToken: string) => void,
  dispatchMaintenance: () => void = () => window.dispatchEvent(new Event(MAINTENANCE_EVENT)),
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const authorization = new Headers(init?.headers).get('authorization')
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
    const res = await fetcher(input, init)
    // Batch links can return 207 when a response contains mixed outcomes.
    if (token && (res.status === 401 || res.status === 207)) {
      const body = await res.clone().json().catch(() => undefined)
      if (isSessionRejection(body)) invalidateSession(token)
    }
    // A change refused during an update or a restart (#132): lib/maintenance
    // listens, without importing this client back.
    if (res.status === 503) dispatchMaintenance()
    return res
  }
}

// A wall display (/wall) signs its calls with its own token, never the
// browser's session.
let wallToken: string | null = null
export function useWallToken(token: string | null): void {
  wallToken = token
}

const linkOptions = {
  url: import.meta.env?.VITE_API_URL ?? '/trpc',
  headers() {
    const token = wallToken ?? localStorage.getItem('token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  },
  fetch: createSessionAwareFetch(fetch, onSessionInvalid),
}

interface CallError { data?: { code?: unknown; sessionInvalid?: unknown } | null }

// A streamed batch answers 200 with one result per call, so a rejected session
// or a refusal during maintenance shows on each call's error rather than on
// the HTTP status: this link reads it there.
export function createSessionLink(
  currentToken: () => string | null,
  invalidateSession: (rejectedToken: string) => void,
  dispatchMaintenance: () => void = () => window.dispatchEvent(new Event(MAINTENANCE_EVENT)),
): TRPCLink<AppRouter> {
  return () => ({ op, next }) => {
    const token = currentToken()
    return next(op).pipe(tap({
      error(err) {
        const data = (err as CallError).data
        if (token && data?.code === 'UNAUTHORIZED' && data.sessionInvalid === true) invalidateSession(token)
        if (data?.code === 'SERVICE_UNAVAILABLE') dispatchMaintenance()
      },
    }))
  }
}

// Calls made together share one request, and the server streams each answer as
// soon as it is ready: a quick call is never held back by a slow one (metrics,
// containers) in the same batch. The account's preferences go on their own, so
// its look applies right after sign-in.
const UNBATCHED = new Set(['user.preferences'])

export const trpc = createTRPCClient<AppRouter>({
  links: [
    createSessionLink(() => wallToken ?? localStorage.getItem('token'), onSessionInvalid),
    splitLink({
      condition: op => UNBATCHED.has(op.path),
      true: httpLink(linkOptions),
      false: httpBatchStreamLink(linkOptions),
    }),
  ],
})
