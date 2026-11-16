// Turns raw SMB journal rows into readable lines: repeated identical events
// become one line with a count, a sign-in that just precedes opening a share
// is folded into that opening, and lines are grouped by local day.

export interface ActivityEvent {
  id: string
  at: Date | string
  user: string | null
  share: string | null
  kind: string
  result: string
  reason: string | null
  machine: string | null
  ip: string | null
}

export interface ActivityRun<E extends ActivityEvent> {
  /** The newest event of the run; its fields describe the whole line. */
  first: E
  count: number
  latest: Date
  earliest: Date
}

/** Identical events further apart than this are separate lines. */
const RUN_GAP_MS = 10 * 60_000
/** A sign-in this close before opening a share is part of that opening. */
const SIGN_IN_FOLD_MS = 60_000

export function machineLabel(e: { machine: string | null; ip: string | null }): string {
  return (e.machine || e.ip || '').toLowerCase()
}

function sameLine(a: ActivityEvent, b: ActivityEvent): boolean {
  return a.user === b.user && a.share === b.share && a.kind === b.kind && a.result === b.result &&
    a.reason === b.reason && machineLabel(a) === machineLabel(b)
}

/** `events` newest first, as the journal returns them. */
export function collapseRuns<E extends ActivityEvent>(events: E[]): ActivityRun<E>[] {
  const kept = events.filter((e, i) => {
    if (e.kind !== 'auth' || e.result !== 'ok') return true
    const at = new Date(e.at).getTime()
    // A newer event opening a share from the same account and machine.
    for (let j = i - 1; j >= 0; j--) {
      const n = events[j]
      const dt = new Date(n.at).getTime() - at
      if (dt > SIGN_IN_FOLD_MS) break
      if (n.kind === 'connect' && n.result === 'ok' && n.user === e.user && machineLabel(n) === machineLabel(e)) return false
    }
    return true
  })
  const runs: ActivityRun<E>[] = []
  for (const e of kept) {
    const at = new Date(e.at)
    const last = runs[runs.length - 1]
    if (last && sameLine(last.first, e) && last.earliest.getTime() - at.getTime() <= RUN_GAP_MS) {
      last.count++
      last.earliest = at
    } else {
      runs.push({ first: e, count: 1, latest: at, earliest: at })
    }
  }
  return runs
}

export interface ActivityDay<E extends ActivityEvent> {
  key: string
  label: string
  runs: ActivityRun<E>[]
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function dayLabel(d: Date, now: number, locale: string): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const that = new Date(d)
  that.setHours(0, 0, 0, 0)
  const days = Math.round((that.getTime() - today.getTime()) / 86_400_000)
  if (days === 0 || days === -1) {
    const s = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day')
    return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1)
  }
  const sameYear = that.getFullYear() === today.getFullYear()
  const s = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) }).format(d)
  return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1)
}

export function groupByDay<E extends ActivityEvent>(runs: ActivityRun<E>[], now: number, locale: string): ActivityDay<E>[] {
  const out: ActivityDay<E>[] = []
  for (const r of runs) {
    const key = dayKey(r.latest)
    const last = out[out.length - 1]
    if (last?.key === key) last.runs.push(r)
    else out.push({ key, label: dayLabel(r.latest, now, locale), runs: [r] })
  }
  return out
}
