import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@brume/shared-types'

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: import.meta.env.VITE_API_URL ?? '/trpc',
      headers() {
        const token = localStorage.getItem('token')
        return token ? { Authorization: `Bearer ${token}` } : {}
      },
    }),
  ],
})
