// Formatting for the properties dialog (#198).

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Human size in powers of 1024, one decimal from KB on (two from GB). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`
  let i = 0
  let v = n
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i >= 3 ? 2 : 1)} ${UNITS[i]}`
}

/** Exact byte count with thousands separators, for next to the human size. */
export function formatExactBytes(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(n)
}

/** h:mm:ss, or m:ss under an hour. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (x: number) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
