import { watch } from 'vue'
import { trpc } from './trpc'
import { useAppearance } from './theme'
import { hydrateAppearance, toLegacy } from './appearance'
import { orderedIds, setOrder } from './sidebar-nav'
import { isLocale, locale, setLocale } from '../i18n'
import { useDeleteConfirm } from './delete-confirm'

// Per-account preference sync. The individual stores (appearance/sidebar order)
// remain localStorage-backed for instant, offline-friendly reads; this layer
// hydrates them from the server on login and pushes local changes back, so the
// same account carries its look and sidebar order across browsers/devices.
// Device-specific prefs (e.g. desktop mode) are intentionally NOT synced.

const { appearance, setAppearance } = useAppearance()
const { confirmFileDelete, setConfirmFileDelete } = useDeleteConfirm()

let pushTimer: ReturnType<typeof setTimeout> | undefined
function schedulePush() {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    trpc.user.updatePreferences.mutate({
      ...toLegacy(appearance.value),
      appearance:   appearance.value,
      sidebarOrder: [...orderedIds.value],
      locale:       locale.value,
      confirmFileDelete: confirmFileDelete.value,
    }).catch(() => { /* best-effort, localStorage remains the source of truth */ })
  }, 600)
}

let started = false

/** Load server-side prefs (applying them locally), then keep the server in sync
 *  with local changes. Safe to call once after authentication. */
export async function syncPreferences() {
  if (started) return
  started = true

  // Until the account's prefs are read, localStorage may hold the previous
  // account's look: pushing it would overwrite this account's. So nothing is
  // pushed before a successful read, which is retried while it fails.
  for (let attempt = 0; ; attempt++) {
    try {
      const p = await trpc.user.preferences.query()
      setAppearance(hydrateAppearance(p))
      if (Array.isArray(p.sidebarOrder) && p.sidebarOrder.length) setOrder(p.sidebarOrder)
      if (isLocale(p.locale)) await setLocale(p.locale)
      if (typeof p.confirmFileDelete === 'boolean') setConfirmFileDelete(p.confirmFileDelete)
      break
    } catch {
      // Offline or restarting: keep the local look and try again later.
      if (attempt >= 5 || !localStorage.getItem('token')) return
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt))
    }
  }

  // Register AFTER hydration so applying server values above doesn't echo back.
  watch([appearance, orderedIds, locale, confirmFileDelete], schedulePush)
}
