// Backups: labels for schedules, retention, repository locations and run results.

export interface Schedule { every: 'manual' | 'hourly' | 'daily' | 'weekly'; minute: number; hour: number; weekday: number }
export interface Retention { keepLast: number; keepDaily: number; keepWeekly: number; keepMonthly: number }
export interface RepoLocation { type: 'local' | 'sftp' | 's3' | 'rest'; path?: string; host?: string; user?: string; port?: number; endpoint?: string; bucket?: string; url?: string }

/** Retention applied to a new plan: a week of dailies, a month of weeklies, half a year of monthlies. */
export const DEFAULT_RETENTION: Retention = { keepLast: 0, keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
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
