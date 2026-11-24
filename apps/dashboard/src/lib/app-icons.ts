import { ref } from 'vue'
import { trpc } from './trpc'

// What each installed app looks like, by app name (the compose project, which
// is also how Monitor names the processes of a container): its catalog logo
// and name, or the generic icon picked for it. Shared, loaded on demand.

export interface AppLook { svg: string | null; glyph: string | null; label: string | null }

const looks = ref<Record<string, AppLook>>({})
let loading: Promise<void> | null = null

/** Load (again) the looks of the installed apps; failures keep initials. */
export function loadAppLooks(): Promise<void> {
  loading ??= (async () => {
    try {
      const [catalog, apps] = await Promise.all([trpc.catalog.list.query().catch(() => []), trpc.container.app.list.query()])
      const byId = new Map(catalog.map(a => [a.id, a]))
      looks.value = Object.fromEntries(apps.map(a => {
        const entry = byId.get(a.app?.labels?.find(l => l.key === 'hsi.catalog.id')?.value ?? '')
        return [a.name, { svg: entry?.icon ?? null, glyph: a.app?.icon ?? null, label: entry?.name ?? null }]
      }))
    } catch { /* no access to the apps: initials only */ } finally { loading = null }
  })()
  return loading
}

export function appLook(name: string): AppLook | null {
  return looks.value[name] ?? null
}
