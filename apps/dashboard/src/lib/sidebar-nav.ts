import { ref, computed } from 'vue'

// The canonical sidebar app list, in default order. `adminOnly` items mirror the
// existing `v-if="isAdmin"` gating in DashboardLayout. Ids match `activeApp` /
// `isActive(id)`. The custom order is persisted per-browser in localStorage,
// alongside theme/accent/desktop-mode (see lib/desktop.ts / lib/theme.ts).
export interface NavItem {
  id:         string
  label:      string
  adminOnly?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'files',     label: 'Files' },
  { id: 'apps',      label: 'Apps' },
  { id: 'storage',   label: 'Storage',   adminOnly: true },
  { id: 'store',     label: 'App Store', adminOnly: true },
  { id: 'monitor',   label: 'Monitor',   adminOnly: true },
  { id: 'sharing',   label: 'Sharing',   adminOnly: true },
  { id: 'settings',  label: 'Settings' },
]

const DEFAULT_ORDER = NAV_ITEMS.map(i => i.id)
const BY_ID = new Map(NAV_ITEMS.map(i => [i.id, i]))
const STORAGE_KEY = 'sidebarOrder'

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return [...DEFAULT_ORDER]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_ORDER]
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return [...DEFAULT_ORDER]
  }
}

const order = ref<string[]>(loadOrder())

// The full ordered id list: the saved order, then any known id missing from it
// appended in default position (so apps added by a future update still appear),
// with unknown/stale ids dropped. Not visibility-filtered.
export const orderedIds = computed<string[]>(() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of order.value) {
    if (BY_ID.has(id) && !seen.has(id)) { out.push(id); seen.add(id) }
  }
  for (const id of DEFAULT_ORDER) if (!seen.has(id)) out.push(id)
  return out
})

/** Reorder live (during a drag) without writing to storage. */
export function reorder(ids: string[]) {
  order.value = ids
}

/** Persist the current order to localStorage. */
export function persistOrder() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order.value)) } catch { /* ignore */ }
}

/** Reorder and persist in one step. */
export function setOrder(ids: string[]) {
  order.value = ids
  persistOrder()
}

/** Clear the custom order back to the default. */
export function resetOrder() {
  order.value = [...DEFAULT_ORDER]
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

/** The visible, ordered nav items for the given admin state. */
export function useSidebarNav(isAdmin: () => boolean) {
  const items = computed<NavItem[]>(() =>
    orderedIds.value
      .map(id => BY_ID.get(id)!)
      .filter(it => !it.adminOnly || isAdmin()),
  )
  return { items }
}
