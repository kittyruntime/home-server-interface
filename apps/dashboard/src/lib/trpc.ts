import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@app/shared-types'

// When a stored session token is rejected (expired or revoked), tear down the
// local session and bounce to the login screen. Guarded on token presence so a
// failed login attempt — which 401s before any token is stored — is left for the
// login form to handle instead of triggering a redirect loop.
function onSessionInvalid() {
  if (!localStorage.getItem('token')) return
  localStorage.removeItem('token')
  localStorage.removeItem('username')
  if (window.location.pathname !== '/login') {
    // Full navigation, not a router push: guarantees every in-memory store and
    // pending request tied to the dead session is discarded.
    window.location.assign('/login')
  }
}

export const trpc = createTRPCProxyClient<AppRouter>({
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
        return res
      },
    }),
  ],
})
