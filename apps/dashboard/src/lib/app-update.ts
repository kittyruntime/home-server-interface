// App updates (#26): wording shared by the App Store and Apps pages.

export interface VersionChange { from: string; to: string }

export function updateText(u: VersionChange): string {
  return `Update available: ${u.from} → ${u.to}`
}

export function updatePlan(name: string, u: VersionChange): { title: string; actionLabel: string } {
  return { title: `Update ${name} to ${u.to}`, actionLabel: 'Update' }
}

export function rollbackPlan(name: string, to: string): { title: string; actionLabel: string } {
  return { title: `Roll back ${name} to ${to}`, actionLabel: 'Roll back' }
}
