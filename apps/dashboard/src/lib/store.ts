// App Store: filters, search and order of the catalog cards.

export interface StoreApp {
  name: string
  category: string
  tagline: string
  description: string
  image: string
  installedApp: { update: unknown; image?: string | null } | null
}

export interface FilterChip { key: string; label: string; count: number }

const isInstalled = (a: StoreApp) => a.installedApp !== null
const hasUpdate = (a: StoreApp) => !!a.installedApp?.update

/** All, then Installed and Updates when there are any, then each category with its count. */
export function filterChips(apps: StoreApp[]): FilterChip[] {
  const chips: FilterChip[] = [{ key: 'All', label: 'All', count: apps.length }]
  const installed = apps.filter(isInstalled).length
  const updates = apps.filter(hasUpdate).length
  if (installed) chips.push({ key: 'Installed', label: 'Installed', count: installed })
  if (updates) chips.push({ key: 'Updates', label: 'Updates', count: updates })
  for (const c of new Set(apps.map(a => a.category))) {
    chips.push({ key: c, label: c, count: apps.filter(a => a.category === c).length })
  }
  return chips
}

export function matchesSearch(a: StoreApp, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || [a.name, a.tagline, a.description, a.category].some(s => s.toLowerCase().includes(q))
}

/** The cards to show: installed apps first under All, catalog order otherwise. */
export function visibleApps<T extends StoreApp>(apps: T[], filter: string, query: string): T[] {
  const kept = apps.filter(a =>
    (filter === 'All' || (filter === 'Installed' ? isInstalled(a) : filter === 'Updates' ? hasUpdate(a) : a.category === filter))
    && matchesSearch(a, query))
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
