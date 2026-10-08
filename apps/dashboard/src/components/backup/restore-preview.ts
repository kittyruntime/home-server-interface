// Configuration restore (#1): wording of the preview and of what is left to do
// after a restore. No Vue imports, so it is tested directly.

export type BackupInfo = { hsiVersion?: string; createdAt?: string; hostname?: string }
export type BackupContents = { users: number; groups: number; places: number; shares: number; connectors: number; apps: string[]; volumes: number }

export function backupLine(b: BackupInfo, format: 1 | 2, locale?: string): string {
  if (format === 1) return 'An older backup (database only)'
  const parts = [`HSI ${b.hsiVersion ?? '?'}`]
  if (b.createdAt) parts.push(new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(b.createdAt)))
  if (b.hostname) parts.push(`from ${b.hostname}`)
  return parts.join(', ')
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function contentsLine(c: BackupContents): string {
  const apps = count(c.apps.length, 'app', 'apps') + (c.apps.length ? ` (${c.apps.join(', ')})` : '')
  return [
    count(c.users, 'account', 'accounts'), count(c.groups, 'group', 'groups'), count(c.places, 'Place', 'Places'),
    count(c.shares, 'share', 'shares'), count(c.connectors, 'notification connector', 'notification connectors'),
    apps, count(c.volumes, 'volume description', 'volume descriptions'),
  ].join(', ')
}

/** What a restore leaves to do: shown after the restart until dismissed. */
export const FOLLOW_UPS = [
  { text: 'Bring the volumes back: each one has a Reapply button on the Volumes page once its disks are connected.', href: '/?app=storage', label: 'Open Storage' },
  { text: 'Start the apps: they were restored stopped.', href: '/?app=apps', label: 'Open Apps' },
  { text: 'Set the Samba passwords: each account needs a new password before it can open the shares (Profile, or Users for an admin).', href: '/?app=settings', label: 'Open Settings' },
]
