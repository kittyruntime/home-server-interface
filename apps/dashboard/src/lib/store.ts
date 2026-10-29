import { tr } from './tr.ts'
// App Store: filters, search and order of the catalog cards.

export interface StoreApp {
  name: string
  category: string
  tagline: string
  description: string
  image: string
  /** The day it joined the catalog, YYYY-MM-DD. */
  added?: string
  installedApp: { update: unknown; image?: string | null } | null
}

/** Card order: installed first (default), by name, or the latest added first. */
export type StoreOrder = 'default' | 'name' | 'added'

const NEW_DAYS = 60
const DAY_MS = 86_400_000

/** Joined the catalog in the last 60 days: marked New, whatever its popularity. */
export function isNew(a: StoreApp, now: Date = new Date()): boolean {
  if (!a.added) return false
  const age = now.getTime() - Date.parse(`${a.added}T00:00:00Z`)
  return age >= 0 && age <= NEW_DAYS * DAY_MS
}

const byName = (a: StoreApp, b: StoreApp) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

export interface FilterChip { key: string; label: string; count: number }

const isInstalled = (a: StoreApp) => a.installedApp !== null
const hasUpdate = (a: StoreApp) => !!a.installedApp?.update

/** All, then Installed and Updates when there are any, then each category with its count. */
export function filterChips(apps: StoreApp[]): FilterChip[] {
  const chips: FilterChip[] = [{ key: 'All', label: tr('lib.store.all', 'All'), count: apps.length }]
  const installed = apps.filter(isInstalled).length
  const updates = apps.filter(hasUpdate).length
  if (installed) chips.push({ key: 'Installed', label: tr('lib.store.installed', 'Installed'), count: installed })
  if (updates) chips.push({ key: 'Updates', label: tr('lib.store.updates', 'Updates'), count: updates })
  for (const c of new Set(apps.map(a => a.category))) {
    chips.push({ key: c, label: categoryLabel(c), count: apps.filter(a => a.category === c).length })
  }
  return chips
}

export function matchesSearch(a: StoreApp, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || [a.name, a.tagline, a.description, a.category].some(s => s.toLowerCase().includes(q))
}

/**
 * The cards to show, in the chosen order. By default: installed apps first
 * under All, catalog order otherwise.
 */
export function visibleApps<T extends StoreApp>(apps: T[], filter: string, query: string, order: StoreOrder = 'default'): T[] {
  const kept = apps.filter(a =>
    (filter === 'All' || (filter === 'Installed' ? isInstalled(a) : filter === 'Updates' ? hasUpdate(a) : a.category === filter))
    && matchesSearch(a, query))
  if (order === 'name') return [...kept].sort(byName)
  if (order === 'added') return [...kept].sort((a, b) => (b.added ?? '').localeCompare(a.added ?? '') || byName(a, b))
  return filter === 'All' ? [...kept.filter(isInstalled), ...kept.filter(a => !isInstalled(a))] : kept
}

/** The version the catalog ships: the image tag (null for a digest or no tag). */
export function catalogVersion(image: string): string | null {
  if (image.includes('@')) return null
  const colon = image.lastIndexOf(':')
  return colon > image.lastIndexOf('/') ? image.slice(colon + 1) : null
}

/** The selected filter while its chip exists; All once it is gone (the last update applied). */
export function keptFilter(chips: FilterChip[], key: string): string {
  return chips.some(c => c.key === key) ? key : 'All'
}

/**
 * The version shown on an app's page: the one installed, or the catalog's for
 * an app not installed. Null when the installed one is unknown (a viewer who
 * is not an admin, an image pinned by digest) rather than a wrong one.
 */
export function versionLabel(a: StoreApp): string | null {
  if (!a.installedApp) {
    const v = catalogVersion(a.image)
    return v ? `catalog ${v}` : null
  }
  const v = a.installedApp.image ? catalogVersion(a.installedApp.image) : null
  return v ? `installed ${v}` : null
}

/** A catalog category in the interface language (the catalog names it in English). */
export function categoryLabel(category: string): string {
  return tr(`lib.store.categories.${category}`, category)
}
