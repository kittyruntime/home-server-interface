// Dates in one style across the dashboard: the day ("Oct 6, 2026") or the day
// and time ("Oct 6, 2026, 2:05 PM"), in the browser's locale.

type DateInput = string | number | Date | null | undefined

function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDay(v: DateInput): string {
  const d = toDate(v)
  return d ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d) : '-'
}

/** The day and time; `seconds` for records where they matter (the audit log). */
export function formatDateTime(v: DateInput, opts: { seconds?: boolean } = {}): string {
  const d = toDate(v)
  return d ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: opts.seconds ? 'medium' : 'short' }).format(d) : '-'
}
