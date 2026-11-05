export interface AppListItem {
  name: string
  status: string
  pendingApply?: boolean
  drifted?: boolean
  app?: { image?: string | null; ports?: Array<{ hostPort: number; containerPort: number }> } | null
}

export function summarizeApps<T extends Pick<AppListItem, 'status' | 'pendingApply' | 'drifted'>>(apps: T[]) {
  return apps.reduce((counts, app) => {
    if (app.status === 'running') counts.running++
    if (app.status === 'stopped') counts.stopped++
    if (app.pendingApply || app.drifted) counts.pending++
    return counts
  }, { running: 0, stopped: 0, pending: 0 })
}

export function filterApps<T extends AppListItem>(apps: T[], query: string): T[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return apps
  return apps.filter(app => [
      app.name,
      app.app?.image ?? '',
      ...(app.app?.ports ?? []).map(port => `${port.hostPort} ${port.containerPort} ${port.hostPort}:${port.containerPort}`),
    ].some(value => value.toLocaleLowerCase().includes(normalized)))
}
