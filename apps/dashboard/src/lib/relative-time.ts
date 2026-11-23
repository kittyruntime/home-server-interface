import { relativeFormat } from './intl-cache'

// "12 minutes ago" in the viewer's language; the exact time goes in a title.
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000], ['month', 30 * 86_400_000], ['week', 7 * 86_400_000],
  ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
]

export function relativeTime(at: Date | string | number, now: number, locale: string): string {
  const diff = new Date(at).getTime() - now
  const rtf = relativeFormat(locale, { numeric: 'auto' })
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
  }
  return rtf.format(0, 'second')
}
