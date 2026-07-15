import { watch } from 'vue'
import { trpc } from './trpc'
import { useTheme, useAccent, type Theme, type Accent } from './theme'
import { orderedIds, setOrder } from './sidebar-nav'

// Per-account preference sync. The individual stores (theme/accent/sidebar order)
// remain localStorage-backed for instant, offline-friendly reads; this layer
// hydrates them from the server on login and pushes local changes back, so the
// same account carries its look and sidebar order across browsers/devices.
// Device-specific prefs (e.g. desktop mode) are intentionally NOT synced.

const { theme, setTheme } = useTheme()
const { accent, setAccent } = useAccent()

let pushTimer: ReturnType<typeof setTimeout> | undefined
function schedulePush() {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    trpc.user.updatePreferences.mutate({
      theme:        theme.value,
      accent:       accent.value,
      sidebarOrder: [...orderedIds.value],
    }).catch(() => { /* best-effort — localStorage remains the source of truth */ })
  }, 600)
}

let started = false

/** Load server-side prefs (applying them locally), then keep the server in sync
 *  with local changes. Safe to call once after authentication. */
export async function syncPreferences() {
  if (started) return
  started = true

  try {
    const p = await trpc.user.preferences.query()
    if (p.theme)  setTheme(p.theme as Theme)
    if (p.accent) setAccent(p.accent as Accent)
    if (Array.isArray(p.sidebarOrder) && p.sidebarOrder.length) setOrder(p.sidebarOrder)
  } catch {
    // Not authenticated / offline — keep whatever localStorage already had.
  }

  // Register AFTER hydration so applying server values above doesn't echo back.
  watch([theme, accent, orderedIds], schedulePush)
}
