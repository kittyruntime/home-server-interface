import { FORMATS, type ValueFormat } from './widget-expr'

// The settings of a custom widget (settings.custom): which sources it reads
// ($1 to $3), how it shows the value and how the value is written.

export type CustomDisplay = 'number' | 'gauge' | 'chart' | 'status' | 'list' | 'text'
export const DISPLAYS: CustomDisplay[] = ['number', 'gauge', 'chart', 'status', 'list', 'text']

export interface CustomConfig {
  sources: string[]
  display: CustomDisplay
  value: string
  format: ValueFormat
  decimals?: number
  prefix?: string
  unit?: string
  warn?: string
  bad?: string
  /** Lower is worse (a battery, free space). */
  below?: boolean
  min?: string
  max?: string
  list?: { path: string; label: string; value: string; format?: ValueFormat }
  yes?: string
  no?: string
  caption?: string
  captionFormat?: ValueFormat
}

const str = (v: unknown, max = 200) => typeof v === 'string' ? v.slice(0, max) : undefined

/** Reads stored settings, tolerating anything a hand edit or an older release left. */
export function customOf(settings: Record<string, unknown> | undefined): CustomConfig {
  const c = (settings?.custom ?? {}) as Record<string, unknown>
  const list = c.list as Record<string, unknown> | undefined
  const decimals = typeof c.decimals === 'number' && c.decimals >= 0 && c.decimals <= 6 ? Math.round(c.decimals) : undefined
  return {
    sources: Array.isArray(c.sources) ? c.sources.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
    display: (['number', 'gauge', 'chart', 'status', 'list', 'text'] as const).find(d => d === c.display) ?? 'number',
    value: str(c.value, 400) ?? '$1',
    format: FORMATS.find(f => f === c.format) ?? 'number',
    decimals,
    prefix: str(c.prefix, 12), unit: str(c.unit, 12),
    warn: str(c.warn, 30), bad: str(c.bad, 30), below: c.below === true,
    min: str(c.min, 30), max: str(c.max, 30),
    list: list ? { path: str(list.path, 400) ?? '', label: str(list.label, 400) ?? '', value: str(list.value, 400) ?? '', format: FORMATS.find(f => f === list.format) } : undefined,
    yes: str(c.yes, 30), no: str(c.no, 30), caption: str(c.caption, 400),
    captionFormat: FORMATS.find(f => f === c.captionFormat),
  }
}

/** Only what is set, to keep the stored settings small. */
export function compactCustom(c: CustomConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { sources: c.sources, display: c.display, value: c.value, format: c.format }
  for (const k of ['decimals', 'prefix', 'unit', 'warn', 'bad', 'min', 'max', 'yes', 'no', 'caption', 'captionFormat'] as const) {
    const v = c[k]
    if (v !== undefined && v !== '') out[k] = v
  }
  if (c.below) out.below = true
  if (c.display === 'list' && c.list) out.list = c.list
  return out
}
