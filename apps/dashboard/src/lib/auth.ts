import { ref, computed } from 'vue'
import { trpc } from './trpc'

const token = ref<string | null>(localStorage.getItem('token'))
const currentUsername = ref<string | null>(localStorage.getItem('username'))

function parseJwt(t: string): Record<string, unknown> {
  try {
    return JSON.parse(atob(t.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return {}
  }
}

export function useAuth() {
  const isAuthenticated = computed(() => !!token.value)
  const isAdmin = computed(() => token.value ? parseJwt(token.value).isAdmin === true : false)
  const isUserManager = computed(() => {
    if (!token.value) return false
    const p = parseJwt(token.value)
    return p.isAdmin === true || p.isUserManager === true
  })
  const mustChangePassword = computed(() =>
    token.value ? parseJwt(token.value).mustChangePassword === true : false,
  )
  const currentUserId = computed(() =>
    token.value ? (parseJwt(token.value).userId as string | null) ?? null : null,
  )

  function hasCapability(capability: string) {
    return computed(() => {
      if (!token.value) return false
      const p = parseJwt(token.value)
      if (p.isAdmin === true) return true
      return Array.isArray(p.capabilities) && p.capabilities.includes(capability)
    })
  }

  async function login(username: string, password: string) {
    const res = await trpc.auth.login.mutate({ username, password })
    token.value = res.token
    currentUsername.value = username
    localStorage.setItem('token', res.token)
    localStorage.setItem('username', username)
  }

  function logout() {
    token.value = null
    currentUsername.value = null
    localStorage.removeItem('token')
    localStorage.removeItem('username')
  }

  // Swap in a token re-issued mid-session (currently: after a password change,
  // which clears mustChangePassword) without a full login round-trip.
  function setToken(newToken: string) {
    token.value = newToken
    localStorage.setItem('token', newToken)
  }

  return {
    token,
    currentUsername,
    currentUserId,
    isAuthenticated,
    isAdmin,
    isUserManager,
    mustChangePassword,
    hasCapability,
    login,
    logout,
    setToken,
  }
}
