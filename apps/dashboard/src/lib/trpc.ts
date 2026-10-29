import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@app/shared-types'

// When a stored session token is rejected (expired or revoked), tear down the
// local session and bounce to the login screen. Guarded on token presence so a
// failed login attempt (which 401s before any token is stored) is left for the
// login form to handle instead of triggering a redirect loop.
function onSessionInvalid() {
  if (!localStorage.getItem('token')) return
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

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: import.meta.env.VITE_API_URL ?? '/trpc',
      headers() {
        const token = localStorage.getItem('token')
        return token ? { Authorization: `Bearer ${token}` } : {}
      },
      async fetch(input, init) {
        const res = await fetch(input, init)
        if (res.status === 401) onSessionInvalid()
        // A change refused during an update or a restart (#132): lib/maintenance
        // listens, without importing this client back.
        if (res.status === 503) window.dispatchEvent(new Event(MAINTENANCE_EVENT))
        return res
      },
    }),
  ],
})
