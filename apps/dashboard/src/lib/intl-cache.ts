// Intl formatters are costly to build (each one loads locale data) and cheap
// to reuse. A list that formats a date per row, or a chart that formats every
// tick, must not build one per value: these return one shared formatter per
// locale and options.

type Locale = string | undefined
const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>()

function memo<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>(kind: string, locale: Locale, opts: object, make: () => T): T {
  const key = `${kind}|${locale ?? ''}|${JSON.stringify(opts)}`
  let f = cache.get(key) as T | undefined
  if (!f) { f = make(); cache.set(key, f) }
  return f
}

export const dateFormat = (locale: Locale, opts: Intl.DateTimeFormatOptions = {}) =>
  memo('d', locale, opts, () => new Intl.DateTimeFormat(locale, opts))

export const numberFormat = (locale: Locale, opts: Intl.NumberFormatOptions = {}) =>
  memo('n', locale, opts, () => new Intl.NumberFormat(locale, opts))

export const relativeFormat = (locale: Locale, opts: Intl.RelativeTimeFormatOptions = {}) =>
  memo('r', locale, opts, () => new Intl.RelativeTimeFormat(locale, opts))
