import { formatBytes } from './file-details'

// What a custom widget shows: an expression over its sources' data, then a
// format. `$1.data.count` is the value at that path in the first source;
// `$1.used / $1.size * 100` computes one; `count($1.sessions, "NowPlayingItem")`
// counts the items where that field is set, `sum($1.items, "size")` adds them.
// In a list, `@` is the current item. Only arithmetic: nothing is executed.

export type Scope = { sources: unknown[]; item?: unknown }

/** Segments of `a.b[2]["odd key"]`. */
export function segments(path: string): Array<string | number> {
  const out: Array<string | number> = []
  const re = /\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|([^.[\]]+)/g
  for (const m of path.matchAll(re)) {
    if (m[1] !== undefined) out.push(Number(m[1]))
    else if (m[2] !== undefined) out.push(m[2].replace(/\\(.)/g, '$1'))
    else if (m[3] !== undefined) out.push(m[3])
  }
  return out
}

export function readPath(value: unknown, path: string): unknown {
  let cur = value
  for (const seg of segments(path)) {
    if (cur == null) return undefined
    if (seg === 'length' && (Array.isArray(cur) || typeof cur === 'string')) { cur = cur.length; continue }
    if (typeof seg === 'number') { cur = Array.isArray(cur) ? cur[seg] : undefined; continue }
    if (typeof cur !== 'object' || !Object.hasOwn(cur as object, seg)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null }
  return null
}

/** Writes the path of a key as an expression reference: `.name` or `["odd key"]`. */
export function pathPart(key: string | number): string {
  if (typeof key === 'number') return `[${key}]`
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `["${key.replace(/["\\]/g, '\\$&')}"]`
}

type Tok = { t: 'num'; v: number } | { t: 'ref'; v: string } | { t: 'str'; v: string } | { t: 'op'; v: string } | { t: 'fn'; v: string }

const REF = /^(\$[1-3]|@)((?:\.[A-Za-z0-9_]+|\[\d+\]|\["(?:[^"\\]|\\.)*"\])*)/

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) { i++; continue }
    const rest = src.slice(i)
    const ref = REF.exec(rest)
    if (ref) { out.push({ t: 'ref', v: ref[0] }); i += ref[0].length; continue }
    const num = /^\d+(\.\d+)?/.exec(rest)
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue }
    const fn = /^(count|sum|min|max|avg)\s*\(/.exec(rest)
    if (fn) { out.push({ t: 'fn', v: fn[1]! }); i += fn[0].length; continue }
    const str = /^"((?:[^"\\]|\\.)*)"/.exec(rest)
    if (str) { out.push({ t: 'str', v: str[1]!.replace(/\\(.)/g, '$1') }); i += str[0].length; continue }
    if ('+-*/(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    throw new Error(`Unexpected "${c}"`)
  }
  return out
}

function refValue(ref: string, scope: Scope): unknown {
  const m = /^(\$([1-3])|@)(.*)$/.exec(ref)!
  const base = m[1] === '@' ? scope.item : scope.sources[Number(m[2]) - 1]
  return readPath(base, m[3]!)
}

function aggregate(fn: string, list: unknown, field: string): number | null {
  if (!Array.isArray(list)) return fn === 'count' ? 0 : null
  if (fn === 'count') return list.filter(x => field ? !!readPath(x, field) : true).length
  const nums = list.map(x => toNumber(field ? readPath(x, field) : x)).filter((n): n is number => n != null)
  if (!nums.length) return fn === 'sum' ? 0 : null
  if (fn === 'sum') return nums.reduce((a, b) => a + b, 0)
  if (fn === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length
  return fn === 'min' ? Math.min(...nums) : Math.max(...nums)
}

/** The value of an expression: the raw value for a single reference, else a number (null when it cannot be computed). */
export function evaluate(src: string, scope: Scope): unknown {
  const expr = src.trim()
  if (!expr) return undefined
  const toks = tokenize(expr)
  if (toks.length === 1 && toks[0]!.t === 'ref') return refValue(toks[0]!.v, scope)
  let i = 0
  const peek = () => toks[i]
  const take = (v?: string) => {
    const tok = toks[i]
    if (!tok || (v && !(tok.t === 'op' && tok.v === v))) throw new Error(v ? `Expected "${v}"` : 'Unexpected end')
    i++
    return tok
  }
  function factor(): number {
    const tok = take()
    if (tok.t === 'num') return tok.v
    if (tok.t === 'ref') return toNumber(refValue(tok.v, scope)) ?? NaN
    if (tok.t === 'op' && tok.v === '-') return -factor()
    if (tok.t === 'op' && tok.v === '(') { const v = sum(); take(')'); return v }
    if (tok.t === 'fn') {
      const arg = take()
      if (arg.t !== 'ref') throw new Error(`${tok.v}() takes a list`)
      let field = ''
      if (peek()?.t === 'op' && peek()!.v === ',') {
        take(',')
        const f = take()
        if (f.t !== 'str') throw new Error(`${tok.v}() takes a field name in quotes`)
        field = f.v
      }
      take(')')
      return aggregate(tok.v, refValue(arg.v, scope), field) ?? NaN
    }
    throw new Error('Unexpected token')
  }
  function product(): number {
    let v = factor()
    while (peek()?.t === 'op' && (peek()!.v === '*' || peek()!.v === '/')) {
      const op = take().v
      const r = factor()
      v = op === '*' ? v * r : r === 0 ? NaN : v / r
    }
    return v
  }
  function sum(): number {
    let v = product()
    while (peek()?.t === 'op' && (peek()!.v === '+' || peek()!.v === '-')) {
      const op = take().v
      const r = product()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  const out = sum()
  if (i < toks.length) throw new Error('Unexpected text at the end')
  return Number.isFinite(out) ? out : null
}

/** Checks an expression without data; the error to show, or null. */
export function checkExpression(src: string): string | null {
  try { evaluate(src, { sources: [{}, {}, {}], item: {} }); return null }
  catch (e) { return (e as Error).message }
}

// ── Formats ───────────────────────────────────────────────────────────────────

export type ValueFormat = 'number' | 'percent' | 'bytes' | 'bitrate' | 'duration' | 'date' | 'text' | 'bool'
export const FORMATS: ValueFormat[] = ['number', 'percent', 'bytes', 'bitrate', 'duration', 'date', 'text', 'bool']

export type FormatOptions = { format: ValueFormat; decimals?: number; prefix?: string; unit?: string; locale: string; now?: number; yes?: string; no?: string }

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d) return `${d} d ${h} h`
  if (h) return `${h} h ${m} min`
  if (m) return `${m} min`
  return `${s} s`
}

export function formatValue(v: unknown, o: FormatOptions): string {
  if (v === undefined || v === null || v === '') return '-'
  const wrap = (s: string) => `${o.prefix ?? ''}${s}${o.unit ? ` ${o.unit}` : ''}`
  if (o.format === 'text') return wrap(typeof v === 'object' ? JSON.stringify(v) : String(v))
  if (o.format === 'bool') {
    const yes = v === true || v === 1 || v === '1' || (typeof v === 'string' && /^(true|yes|on|ok|up)$/i.test(v))
    return yes ? (o.yes || 'Yes') : (o.no || 'No')
  }
  if (o.format === 'date') {
    const n = toNumber(v)
    const d = n != null ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v))
    if (Number.isNaN(d.getTime())) return wrap(String(v))
    const rtf = new Intl.RelativeTimeFormat(o.locale, { numeric: 'auto' })
    const diff = d.getTime() - (o.now ?? Date.now())
    for (const [unit, ms] of [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]] as const) {
      if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
    }
    return rtf.format(Math.round(diff / 1000), 'second')
  }
  const n = toNumber(v)
  if (n == null) return wrap(typeof v === 'object' ? JSON.stringify(v) : String(v))
  if (o.format === 'bytes') return wrap(formatBytes(n))
  if (o.format === 'bitrate') return wrap(`${formatBytes(n)}/s`)
  if (o.format === 'duration') return wrap(formatDuration(n))
  const digits = o.decimals ?? (Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : 1)
  const text = new Intl.NumberFormat(o.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)
  return o.format === 'percent' ? `${o.prefix ?? ''}${text} %` : wrap(text)
}

export type Level = 'ok' | 'warn' | 'bad'

/** Level of a number against its thresholds, either way. */
export function levelOf(v: unknown, warn: string | undefined, bad: string | undefined, below = false): Level | null {
  const n = toNumber(v)
  if (n == null) return null
  const w = toNumber(warn), b = toNumber(bad)
  if (w == null && b == null) return null
  const past = (t: number | null) => t != null && (below ? n <= t : n >= t)
  return past(b) ? 'bad' : past(w) ? 'warn' : 'ok'
}
