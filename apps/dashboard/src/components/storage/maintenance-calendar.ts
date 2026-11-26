// The next days of scheduled maintenance, computed from the saved schedules
// with the worker's rule (maintenance_schedule.go slotMatches): a task runs at
// its hour, every day, on its weekday, or on its day of the month, local time.
// Pure, tested with node (tests/maintenance-calendar.test.ts).

export type Schedule = {
  every:   'off' | 'daily' | 'weekly' | 'monthly'
  weekday: number // 0 = Sunday, for weekly
  day:     number // 1-28, for monthly
  hour:    number // 0-23, local time
}

function matchesDay(s: Schedule, weekday: number, monthDay: number): boolean {
  switch (s.every) {
    case 'daily':   return true
    case 'weekly':  return weekday === s.weekday
    case 'monthly': return monthDay === s.day
    default:        return false
  }
}

type Day = { y: number; m: number; d: number; weekday: number }
const MIN = 60_000

/** The days from `from`'s day on, on the server's clock when its offset is
 *  known (minutes, as Date.getTimezoneOffset gives them), else the browser's;
 *  `at` turns a day and an hour back into the real instant. */
function clock(from: Date, offset?: number) {
  if (offset === undefined) {
    const day = (i: number): Day => {
      const x = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)
      return { y: x.getFullYear(), m: x.getMonth(), d: x.getDate(), weekday: x.getDay() }
    }
    return { day, at: (k: Day, hour: number) => new Date(k.y, k.m, k.d, hour) }
  }
  const wall = new Date(from.getTime() - offset * MIN)
  const day = (i: number): Day => {
    const x = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + i))
    return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), weekday: x.getUTCDay() }
  }
  return { day, at: (k: Day, hour: number) => new Date(Date.UTC(k.y, k.m, k.d, hour) + offset * MIN) }
}

/** Every run of `s` from `from` (included) over the `days` days starting on
 *  `from`'s day, on the server's clock when `serverOffset` is given. */
export function occurrences(s: Schedule, from: Date, days: number, serverOffset?: number): Date[] {
  const c = clock(from, serverOffset)
  const out: Date[] = []
  for (let i = 0; i < days; i++) {
    const k = c.day(i)
    if (!matchesDay(s, k.weekday, k.d)) continue
    const slot = c.at(k, s.hour)
    if (slot >= from) out.push(slot)
  }
  return out
}

/** One entry per day (a local Date holding the server's day), with the tasks
 *  that run that day. */
export function calendar(tasks: Record<string, Schedule>, from: Date, days = 14, serverOffset?: number): { date: Date; tasks: string[] }[] {
  const c = clock(from, serverOffset)
  const out = Array.from({ length: days }, (_, i) => {
    const k = c.day(i)
    return { date: new Date(k.y, k.m, k.d), tasks: [] as string[], key: `${k.y}-${k.m}-${k.d}` }
  })
  for (const [id, s] of Object.entries(tasks)) {
    for (let i = 0; i < days; i++) {
      const k = c.day(i)
      if (!matchesDay(s, k.weekday, k.d) || c.at(k, s.hour) < from) continue
      const entry = out[i]!
      if (!entry.tasks.includes(id)) entry.tasks.push(id)
    }
  }
  return out.map(({ date, tasks: t }) => ({ date, tasks: t }))
}
