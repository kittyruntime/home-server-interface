import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { z } from 'zod'
import { prisma } from '@app/database'
import { requestSync } from '../nats'
import { decryptSecret, encryptSecret } from './secrets'
import { reconcileSource } from './alert-sampler'
import { log } from '../utils/log'

// Data sources of custom dashboard widgets. HSI reads them, not the browser:
// the server reaches local services over plain HTTP whatever the dashboard's
// own address, and secret headers never leave it. Each read is kept, so every
// widget on that source shows the same value; a numeric value can be kept as
// a 7-day history, and a rule can raise an alert that notifies like any other.

export const WIDGET_COMMANDS = ['disks', 'addresses', 'failed-units', 'sensors', 'zpool', 'mdstat', 'docker-stats', 'journal-errors', 'df'] as const
export const ALERT_SOURCE = 'dashboard.widget'
export const MAX_BODY = 256 * 1024
export const MAX_PUSH = 64 * 1024
const HISTORY_DAYS = 7
const DAY = 86_400_000

const zPath = z.string().max(200).regex(/^[A-Za-z0-9_$@.\-[\] ]*$/, 'Use names, dots and [n] in a path')
export const zHeader = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'Not a valid header name'),
  // Empty on a secret header: keep the stored value.
  value: z.string().max(2048).refine(v => !/[\r\n]/.test(v), 'One line only'),
  secret: z.boolean(),
})
export const zRule = z.object({
  path: zPath,
  op: z.enum(['gt', 'lt', 'eq', 'ne']),
  value: z.string().max(200),
  severity: z.enum(['warning', 'critical']),
  message: z.string().max(200),
})
export type AlertRule = z.infer<typeof zRule>

export const zSourceInput = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['http', 'push', 'command']),
  url: z.string().max(2048).default(''),
  headers: z.array(zHeader).max(12).default([]),
  command: z.string().max(32).default(''),
  intervalSec: z.number().int().min(30).max(86_400).default(60),
  visibility: z.enum(['admins', 'everyone']).default('admins'),
  trackPath: zPath.default(''),
  alert: zRule.nullable().default(null),
  allowSelfSigned: z.boolean().default(false),
}).superRefine((s, ctx) => {
  if (s.kind === 'http') {
    try {
      const u = new URL(s.url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
    } catch { ctx.addIssue({ code: 'custom', path: ['url'], message: 'Enter an http:// or https:// address' }) }
  }
  if (s.kind === 'command' && !(WIDGET_COMMANDS as readonly string[]).includes(s.command)) {
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'Unknown command' })
  }
})
export type SourceInput = z.infer<typeof zSourceInput>

type StoredHeader = { name: string; value: string; secret: boolean }

// ── Values ────────────────────────────────────────────────────────────────────

/** Segments of `a.b[2].c`: names and array indexes. */
export function pathSegments(path: string): Array<string | number> {
  const out: Array<string | number> = []
  for (const part of path.split('.')) {
    if (!part) continue
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part)
    if (!m) { out.push(part); continue }
    if (m[1]) out.push(m[1])
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]))
  }
  return out
}

/** The value at a path; `length` of an array or a string is its size. */
export function readPath(value: unknown, path: string): unknown {
  let cur: unknown = value
  for (const seg of pathSegments(path)) {
    if (cur == null) return undefined
    if (seg === 'length' && (Array.isArray(cur) || typeof cur === 'string')) { cur = cur.length; continue }
    if (typeof seg === 'number') { cur = Array.isArray(cur) ? cur[seg] : undefined; continue }
    if (typeof cur !== 'object' || !Object.hasOwn(cur as object, seg)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null }
  return null
}

export function ruleMatches(rule: AlertRule, value: unknown): boolean {
  const v = readPath(value, rule.path)
  if (v === undefined) return false
  const n = asNumber(v), target = asNumber(rule.value)
  switch (rule.op) {
    case 'gt': return n != null && target != null && n > target
    case 'lt': return n != null && target != null && n < target
    case 'eq': return n != null && target != null ? n === target : String(v) === rule.value
    case 'ne': return n != null && target != null ? n !== target : String(v) !== rule.value
  }
}

/** JSON, one JSON value per line, or text as { text }. */
export function parseBody(text: string): unknown {
  const t = text.trim()
  try { return JSON.parse(t) } catch { /* not JSON */ }
  const lines = t.split('\n').filter(Boolean)
  if (lines.length > 1) {
    const parsed: unknown[] = []
    for (const l of lines) { try { parsed.push(JSON.parse(l)) } catch { return { text } } }
    return parsed
  }
  return { text }
}

// ── Reading ───────────────────────────────────────────────────────────────────

export function httpGet(url: string, headers: Record<string, string>, timeoutMs = 8000, allowSelfSigned = false): Promise<unknown> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
      // The certificate is checked unless the admin accepted a self-signed one
      // for this source.
      method: 'GET', timeout: timeoutMs, rejectUnauthorized: !allowSelfSigned,
      headers: { 'Accept': 'application/json, text/plain;q=0.8', 'User-Agent': 'hsi-widget', ...headers },
    }, res => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) { res.resume(); return reject(new Error(`The address redirects (HTTP ${status}); enter the final address`)) }
      if (status >= 400) { res.resume(); return reject(new Error(`HTTP ${status}`)) }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) { req.destroy(new Error('The answer is larger than 256 KB')); return }
        chunks.push(c)
      })
      res.on('end', () => resolve(parseBody(Buffer.concat(chunks).toString('utf8'))))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('No answer within 8 seconds')))
    req.on('error', e => reject(new Error((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'Connection refused' : e.message)))
    req.end()
  })
}

type SourceRow = {
  id: string; name: string; kind: string; url: string; headers: string; command: string
  intervalSec: number; visibility: string; pushHash: string | null; trackPath: string; alert: string
  lastValue: string | null; lastAt: Date | null; lastError: string | null
  allowSelfSigned: boolean
}

export function storedHeaders(text: string): StoredHeader[] {
  try {
    const list = JSON.parse(text) as StoredHeader[]
    return Array.isArray(list) ? list.filter(h => h && typeof h.name === 'string' && typeof h.value === 'string') : []
  } catch { return [] }
}

/** Same scheme, host and port: a stored secret only ever goes where it was meant to. */
export function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin } catch { return false }
}

/** The headers to store: secret values encrypted; an empty secret keeps the old
 *  one only while the address stays on the same origin (`previous` is then
 *  the stored headers, else []), so a changed address needs the secret again. */
export function headersToStore(input: SourceInput['headers'], previous: StoredHeader[]): StoredHeader[] {
  return input.map(h => {
    if (!h.secret) return { name: h.name, value: h.value, secret: false }
    if (h.value === '') {
      const old = previous.find(p => p.secret && p.name.toLowerCase() === h.name.toLowerCase())
      return { name: h.name, value: old?.value ?? '', secret: true }
    }
    return { name: h.name, value: encryptSecret(h.value), secret: true }
  })
}

function sentHeaders(stored: StoredHeader[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of stored) out[h.name] = h.secret ? (h.value ? decryptSecret(h.value) : '') : h.value
  return out
}

export function parseRule(text: string): AlertRule | null {
  if (!text) return null
  try { const r = zRule.safeParse(JSON.parse(text)); return r.success ? r.data : null } catch { return null }
}

/** Reads a source now, from its address or command (push sources are not read). */
export async function readSource(src: Pick<SourceRow, 'kind' | 'url' | 'headers' | 'command' | 'allowSelfSigned'>): Promise<unknown> {
  if (src.kind === 'http') return httpGet(src.url, sentHeaders(storedHeaders(src.headers)), 8000, src.allowSelfSigned)
  if (src.kind === 'command') return (await requestSync<{ value: unknown }>('root.widget.command', { id: src.command }, 15_000)).value
  throw new Error('This source receives its data from a script')
}

/** Stores a value read or pushed, its history point and the alert it raises. */
export async function recordValue(src: SourceRow, value: unknown, error: string | null): Promise<void> {
  const now = new Date()
  const text = value === undefined ? null : JSON.stringify(value)
  await prisma.widgetSource.update({
    where: { id: src.id },
    data: error ? { lastAt: now, lastError: error.slice(0, 300) } : { lastValue: text && text.length <= MAX_BODY * 2 ? text : null, lastAt: now, lastError: null },
  })
  if (error) return
  if (src.trackPath) {
    const n = asNumber(readPath(value, src.trackPath))
    if (n != null) await prisma.widgetSourceSample.create({ data: { sourceId: src.id, value: n } })
  }
  const rule = parseRule(src.alert)
  await reconcileSource(ALERT_SOURCE, {
    checked: [src.id],
    found: rule && ruleMatches(rule, value)
      ? [{ target: src.id, severity: rule.severity, message: alertMessage(src.name, rule, readPath(value, rule.path)) }]
      : [],
  })
}

export function alertMessage(name: string, rule: AlertRule, value: unknown): string {
  const shown = typeof value === 'object' ? JSON.stringify(value) : String(value)
  const base = rule.message.trim() || `${name}: ${rule.path || 'value'} is ${shown}`
  return base.replace(/\{value\}/g, shown).slice(0, 300)
}

async function runOne(src: SourceRow): Promise<void> {
  try { await recordValue(src, await readSource(src), null) } catch (e) { await recordValue(src, undefined, e instanceof Error ? e.message : String(e)).catch(() => {}) }
}

const running = new Set<string>()
export async function refreshSource(id: string): Promise<void> {
  if (running.has(id)) return
  const src = await prisma.widgetSource.findUnique({ where: { id } })
  if (!src || src.kind === 'push') return
  running.add(id)
  try { await runOne(src) } finally { running.delete(id) }
}

async function tick(): Promise<void> {
  const now = Date.now()
  const due = (await prisma.widgetSource.findMany({ where: { kind: { in: ['http', 'command'] } } }))
    .filter(s => !s.lastAt || now - s.lastAt.getTime() >= s.intervalSec * 1000)
  await Promise.all(due.slice(0, 20).map(s => refreshSource(s.id)))
  await prisma.widgetSourceSample.deleteMany({ where: { timestamp: { lt: new Date(now - HISTORY_DAYS * DAY) } } })
}

export function startWidgetSources(): void {
  setInterval(() => { tick().catch(e => log.warn({ err: e }, 'widget sources failed')) }, 10_000)
}

// ── Push ──────────────────────────────────────────────────────────────────────

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export function newPushToken(): string { return `hsiw_${randomBytes(24).toString('base64url')}` }

export function tokenMatches(token: string, hash: string | null): boolean {
  if (!hash) return false
  const a = Buffer.from(hashToken(token), 'hex'), b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Takes a value a script sent; false when the token does not match. */
export async function acceptPush(id: string, token: string, value: unknown): Promise<boolean> {
  const src = await prisma.widgetSource.findUnique({ where: { id } })
  if (!src || src.kind !== 'push' || !tokenMatches(token, src.pushHash)) return false
  await recordValue(src, value, null)
  return true
}

// ── Views ─────────────────────────────────────────────────────────────────────

/** A source as its settings show it: secret values are never sent back. */
export function sourceView(s: SourceRow) {
  return {
    id: s.id, name: s.name, kind: s.kind, url: s.url, command: s.command, intervalSec: s.intervalSec,
    visibility: s.visibility, trackPath: s.trackPath, alert: parseRule(s.alert),
    headers: storedHeaders(s.headers).map(h => ({ name: h.name, value: h.secret ? '' : h.value, secret: h.secret })),
    hasPushToken: !!s.pushHash, lastAt: s.lastAt, lastError: s.lastError, allowSelfSigned: s.allowSelfSigned,
  }
}

export function lastValueOf(s: Pick<SourceRow, 'lastValue'>): unknown {
  if (!s.lastValue) return undefined
  try { return JSON.parse(s.lastValue) } catch { return undefined }
}
