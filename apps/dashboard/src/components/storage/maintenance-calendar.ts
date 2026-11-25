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

function matches(s: Schedule, d: Date): boolean {
  switch (s.every) {
    case 'daily':   return true
    case 'weekly':  return d.getDay() === s.weekday
    case 'monthly': return d.getDate() === s.day
    default:        return false
  }
}

/** Day `i` after the day of `from`, at midnight. */
const dayAfter = (from: Date, i: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)

/** Every run of `s` from `from` (included) over the `days` days starting on `from`'s day. */
export function occurrences(s: Schedule, from: Date, days: number): Date[] {
  const out: Date[] = []
  for (let i = 0; i < days; i++) {
    const day = dayAfter(from, i)
    if (!matches(s, day)) continue
    const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), s.hour)
    if (slot >= from) out.push(slot)
  }
  return out
}

/** One entry per day, with the tasks that run that day. */
export function calendar(tasks: Record<string, Schedule>, from: Date, days = 14): { date: Date; tasks: string[] }[] {
  const out = Array.from({ length: days }, (_, i) => ({ date: dayAfter(from, i), tasks: [] as string[] }))
  for (const [id, s] of Object.entries(tasks)) {
    for (const run of occurrences(s, from, days)) {
      const entry = out.find(e => e.date.toDateString() === run.toDateString())
      if (entry && !entry.tasks.includes(id)) entry.tasks.push(id)
    }
  }
  return out
}
