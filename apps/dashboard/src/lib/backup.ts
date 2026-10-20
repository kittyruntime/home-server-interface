// Backups: labels for schedules, retention, repository locations and run results.

export interface Schedule { every: 'manual' | 'hourly' | 'daily' | 'weekly'; minute: number; hour: number; weekday: number }
export interface Retention { keepLast: number; keepDaily: number; keepWeekly: number; keepMonthly: number }
export interface RepoLocation { type: 'local' | 'sftp' | 's3' | 'rest'; path?: string; host?: string; user?: string; port?: number; endpoint?: string; bucket?: string; url?: string }

/** Retention applied to a new plan: a week of dailies, a month of weeklies, half a year of monthlies. */
export const DEFAULT_RETENTION: Retention = { keepLast: 0, keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number) => String(n).padStart(2, '0')

export function scheduleLabel(s: Schedule): string {
  const at = `${pad(s.hour)}:${pad(s.minute)}`
  switch (s.every) {
    case 'manual': return 'Manual'
    case 'hourly': return `Every hour at :${pad(s.minute)}`
    case 'daily': return `Every day at ${at}`
    case 'weekly': return `Every ${WEEKDAYS[s.weekday]} at ${at}`
  }
}

/** Only the periods that keep at least one snapshot, e.g. "Keeps 7 daily, 4 weekly". */
export function retentionLabel(r: Retention): string {
  const parts: string[] = []
  if (r.keepLast > 0) parts.push(`the last ${r.keepLast}`)
  if (r.keepDaily > 0) parts.push(`${r.keepDaily} daily`)
  if (r.keepWeekly > 0) parts.push(`${r.keepWeekly} weekly`)
  if (r.keepMonthly > 0) parts.push(`${r.keepMonthly} monthly`)
  return parts.length ? `Keeps ${parts.join(', ')}` : 'Keeps nothing'
}

/** Where the repository lives, without credentials: a path, a user@host:path, a bucket path or a URL. */
export function locationLabel(r: RepoLocation): string {
  switch (r.type) {
    case 'local': return r.path ?? ''
    case 'sftp': {
      const target = `${r.user}@${r.host}`
      // A non-default port sits between the host and the path, as restic's sftp URL form reads it.
      return r.port && r.port !== 22 ? `${target}:${r.port}:${r.path}` : `${target}:${r.path}`
    }
    case 's3': return [r.endpoint, r.bucket, r.path].filter(Boolean).join('/')
    case 'rest': return r.url ?? ''
  }
}

function ago(end: Date, now: Date): string {
  const s = Math.floor((now.getTime() - end.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** The last run as a short sentence and the colour it deserves. */
export function runLabel(r: { status: string; end?: string; error?: string } | null, now: Date = new Date()): { text: string; tone: 'ok' | 'warn' | 'err' | 'muted' } {
  if (!r) return { text: 'Never run', tone: 'muted' }
  if (r.status === 'success') {
    const text = r.end ? `Succeeded ${ago(new Date(r.end), now)}` : 'Succeeded'
    return { text, tone: 'ok' }
  }
  if (r.status === 'failed') return { text: `Failed: ${(r.error ?? 'unknown error').slice(0, 120)}`, tone: 'err' }
  if (r.status === 'running') return { text: 'Running', tone: 'muted' }
  return { text: r.status, tone: 'muted' }
}

/** Binary units with one decimal from KB up, e.g. 1536 becomes "1.5 KB". */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return `${value.toFixed(1)} ${units[i]}`
}

/** The directory above a path, "/" for a top-level entry. */
export function parentPath(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** When a future run or check happens, e.g. "in 3 h"; "due now" once the time has passed. */
export function untilLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Not scheduled'
  const s = Math.floor((new Date(iso).getTime() - now.getTime()) / 1000)
  if (s < 60) return 'due now'
  if (s < 3600) return `in ${Math.floor(s / 60)} min`
  if (s < 86400) return `in ${Math.floor(s / 3600)} h`
  return `in ${Math.floor(s / 86400)} d`
}

/** How long a run took, e.g. "42 s", "3 min 5 s", "1 h 12 min"; empty while it runs. */
export function durationLabel(start: string, end?: string): string {
  if (!end) return ''
  const s = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

/** The status poll: every 5 s while a plan runs, else every minute. */
export function pollDelay(plans: Array<{ progress: unknown }>): number {
  return plans.some(p => p.progress) ? 5_000 : 60_000
}

const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean)

// Plan form: the editable fields of both plan types, so switching the type
// while creating keeps what was typed.
export interface PlanFormState {
  id: string
  name: string
  type: 'sync' | 'versions'
  enabled: boolean
  schedule: Schedule
  sync: {
    direction: 'push' | 'pull'
    source: string
    destination: string
    remote: boolean
    remoteHost: string
    remoteUser: string
    remotePort: number
    sshKeyPath: string
    deleteExtra: boolean
    compress: boolean
    bandwidthLimit: number
    excludes: string
  }
  versions: { sources: string; repository: string; excludes: string; stopApps: string[]; retention: Retention }
}

export interface PlanStatusLike {
  id: string
  name: string
  type: 'sync' | 'versions'
  enabled: boolean
  schedule: { every: string; minute: number; hour: number; weekday: number }
  sync?: Record<string, unknown>
  versions?: { sources: string[]; repository: string; excludes: string[]; stopApps: string[]; retention: Retention }
}

export function emptyPlanForm(id: string, repository = ''): PlanFormState {
  return {
    id, name: '', type: 'versions', enabled: true,
    schedule: { every: 'daily', minute: 0, hour: 2, weekday: 0 },
    sync: {
      direction: 'push', source: '', destination: '', remote: false, remoteHost: '', remoteUser: '', remotePort: 22,
      sshKeyPath: '', deleteExtra: false, compress: true, bandwidthLimit: 0, excludes: '',
    },
    versions: { sources: '', repository, excludes: '', stopApps: [], retention: { ...DEFAULT_RETENTION } },
  }
}

export function planFormOf(p: PlanStatusLike): PlanFormState {
  const f = emptyPlanForm(p.id)
  f.name = p.name
  f.type = p.type
  f.enabled = p.enabled
  f.schedule = { ...p.schedule, every: p.schedule.every as Schedule['every'] }
  if (p.sync) {
    const s = p.sync as Omit<PlanFormState['sync'], 'remote' | 'excludes'> & { excludes?: string[] }
    f.sync = { ...f.sync, ...s, remote: Boolean(s.remoteHost), excludes: (s.excludes ?? []).join('\n') }
  }
  if (p.versions) {
    const v = p.versions
    f.versions = { sources: v.sources.join('\n'), repository: v.repository, excludes: v.excludes.join('\n'), stopApps: [...v.stopApps], retention: { ...v.retention } }
  }
  return f
}

/** The `plan` of backup.plan.save: only the options of the chosen type, remote fields only for a remote target. */
export function planPayload(f: PlanFormState) {
  const base = { id: f.id, name: f.name.trim(), type: f.type, enabled: f.enabled, schedule: { ...f.schedule } }
  if (f.type === 'sync') {
    const s = f.sync
    return {
      ...base,
      sync: {
        direction: s.direction, source: s.source.trim(), destination: s.destination.trim(),
        remoteHost: s.remote ? s.remoteHost.trim() : '',
        remoteUser: s.remote ? s.remoteUser.trim() : '',
        remotePort: s.remote ? s.remotePort : 22,
        sshKeyPath: s.remote ? s.sshKeyPath.trim() : '',
        deleteExtra: s.deleteExtra, compress: s.compress, bandwidthLimit: s.bandwidthLimit,
        excludes: lines(s.excludes),
      },
    }
  }
  const v = f.versions
  return {
    ...base,
    versions: { sources: lines(v.sources), repository: v.repository, excludes: lines(v.excludes), stopApps: [...v.stopApps], retention: { ...v.retention } },
  }
}

// Repository form. Secrets are never read back: on edit they start empty and
// a blank secret keeps the stored one.
export interface CheckSchedule { every: 'off' | 'daily' | 'weekly' | 'monthly'; hour: number; weekday: number; day: number; subset: string }

export interface RepositoryFormState {
  id: string
  name: string
  type: RepoLocation['type']
  path: string
  host: string
  user: string
  port: number
  endpoint: string
  bucket: string
  url: string
  check: { every: CheckSchedule['every']; hour: number; weekday: number; day: number; subsetPercent: number }
  secrets: { password: string; sshKeyPath: string; accessKeyId: string; secretAccessKey: string; restUser: string; restPassword: string }
}

export interface RepositoryStatusLike extends RepoLocation {
  id: string
  name: string
  check: { every: string; hour: number; weekday: number; day: number; subset: string }
}

export function emptyRepositoryForm(id: string): RepositoryFormState {
  return {
    id, name: '', type: 'local', path: '', host: '', user: '', port: 22, endpoint: '', bucket: '', url: '',
    check: { every: 'weekly', hour: 4, weekday: 0, day: 1, subsetPercent: 5 },
    secrets: { password: '', sshKeyPath: '', accessKeyId: '', secretAccessKey: '', restUser: '', restPassword: '' },
  }
}

export function repositoryFormOf(r: RepositoryStatusLike): RepositoryFormState {
  const f = emptyRepositoryForm(r.id)
  const percent = Number.parseInt(r.check.subset, 10)
  return {
    ...f,
    name: r.name, type: r.type,
    path: r.path ?? '', host: r.host ?? '', user: r.user ?? '', port: r.port || 22,
    endpoint: r.endpoint ?? '', bucket: r.bucket ?? '', url: r.url ?? '',
    check: {
      every: r.check.every as CheckSchedule['every'], hour: r.check.hour, weekday: r.check.weekday,
      day: r.check.day || 1, subsetPercent: Number.isFinite(percent) ? percent : 5,
    },
  }
}

/** The input of backup.repository.save: the location fields and secrets of the chosen type only. */
export function repositoryPayload(f: RepositoryFormState) {
  const location: Record<string, string | number> = {}
  const secrets: Record<string, string> = { password: f.secrets.password }
  switch (f.type) {
    case 'local':
      location.path = f.path.trim()
      break
    case 'sftp':
      Object.assign(location, { user: f.user.trim(), host: f.host.trim(), port: f.port, path: f.path.trim() })
      secrets.sshKeyPath = f.secrets.sshKeyPath.trim()
      break
    case 's3':
      Object.assign(location, { endpoint: f.endpoint.trim(), bucket: f.bucket.trim(), path: f.path.trim() })
      secrets.accessKeyId = f.secrets.accessKeyId.trim()
      secrets.secretAccessKey = f.secrets.secretAccessKey
      break
    case 'rest':
      location.url = f.url.trim()
      secrets.restUser = f.secrets.restUser.trim()
      secrets.restPassword = f.secrets.restPassword
      break
  }
  const c = f.check
  return {
    repository: {
      id: f.id, name: f.name.trim(), type: f.type, ...location,
      check: { every: c.every, hour: c.hour, weekday: c.weekday, day: c.day, subset: `${c.subsetPercent}%` },
    },
    secrets,
  }
}

/**
 * Whether a refused preview asks for the password of an existing repository
 * (the worker's EPASSWORD: a repository already at the location, or a wrong
 * password). Only the message reaches the dashboard, so it is matched on.
 */
export function asksRepositoryPassword(message: string): boolean {
  return /enter its password|wrong password for this repository/i.test(message)
}

/** Text colour of a runLabel tone. */
export const TONE_CLASS: Record<ReturnType<typeof runLabel>['tone'], string> = {
  ok: 'text-success', warn: 'text-warning', err: 'text-danger', muted: 'text-[var(--c-text-3)]',
}

