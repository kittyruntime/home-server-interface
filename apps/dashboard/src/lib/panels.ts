import { defineAsyncComponent } from 'vue'

// One place for the app panels, shared by the single-panel layout and the
// desktop windows. Each panel is its own chunk so the first paint only pays for
// the shell; prefetchPanels() then warms the chunks while the browser is idle,
// so opening an app never waits on the network.

const loaders = {
  files: () => import('../components/file-browser/FileBrowserPanel.vue'),
  apps: () => import('../components/apps/AppsPanel.vue'),
  settings: () => import('../components/SettingsPanel.vue'),
  storage: () => import('../components/storage/StoragePanel.vue'),
  store: () => import('../components/store/AppStorePanel.vue'),
  monitor: () => import('../components/monitor/MonitorPanel.vue'),
  sharing: () => import('../components/sharing/SharingPanel.vue'),
  assistant: () => import('../components/assistant/AssistantPanel.vue'),
  activity: () => import('../components/activity/ActivityPanel.vue'),
}

export type PanelId = keyof typeof loaders

export const FileBrowserPanel = defineAsyncComponent(loaders.files)
export const AppsPanel = defineAsyncComponent(loaders.apps)
export const SettingsPanel = defineAsyncComponent(loaders.settings)
export const StoragePanel = defineAsyncComponent(loaders.storage)
export const AppStorePanel = defineAsyncComponent(loaders.store)
export const MonitorPanel = defineAsyncComponent(loaders.monitor)
export const SharingPanel = defineAsyncComponent(loaders.sharing)
export const AssistantPanel = defineAsyncComponent(loaders.assistant)
export const ActivityPanel = defineAsyncComponent(loaders.activity)

const warmed = new Set<string>()

/** Fetches one panel's chunk ahead of use (on hover or focus of its entry). */
export function prefetchPanel(id: string): Promise<unknown> {
  if (warmed.has(id) || !(id in loaders)) return Promise.resolve()
  warmed.add(id)
  return loaders[id as PanelId]().catch(() => warmed.delete(id))
}

/**
 * Fetches the given panels one at a time, each when the browser is idle, so
 * the warm-up never competes with what the user is doing. Skipped in
 * development, where a panel is hundreds of unbundled modules.
 */
export function prefetchPanels(ids: readonly string[]) {
  if (import.meta.env.DEV) return
  const queue = ids.filter(id => id in loaders && !warmed.has(id))
  const idle: (cb: () => void) => void = typeof requestIdleCallback === 'function'
    ? cb => requestIdleCallback(cb, { timeout: 3000 })
    : cb => setTimeout(cb, 300)
  const next = () => {
    const id = queue.shift()
    if (id) void prefetchPanel(id).then(() => idle(next))
  }
  idle(next)
}
