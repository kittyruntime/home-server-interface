import { tr } from './tr.ts'
// App updates (#26): wording shared by the App Store and Apps pages.

export interface VersionChange { from: string; to: string }

export function updateText(u: VersionChange): string {
  return tr('lib.app_update.updateAvailable', `Update available: ${u.from} → ${u.to}`, { p0: u.from, p1: u.to })
}

export function updatePlan(name: string, u: VersionChange): { title: string; actionLabel: string } {
  return { title: tr('lib.app_update.updateTo', `Update ${name} to ${u.to}`, { p0: name, p1: u.to }), actionLabel: tr('lib.app_update.update', 'Update') }
}

export function rollbackPlan(name: string, to: string): { title: string; actionLabel: string } {
  return { title: tr('lib.app_update.rollBackTo', `Roll back ${name} to ${to}`, { p0: name, p1: to }), actionLabel: tr('lib.app_update.rollBack', 'Roll back') }
}
