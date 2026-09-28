import { prisma } from "@app/database"
import { log } from "../utils/log"
import { encryptSecret, isEncrypted, revealSecret, secretsKey, SecretsError, UNREADABLE_SECRETS } from "./secrets"

// Connector shapes. Stored: what the database holds (secrets encrypted).
// Resolved: plaintext, server-side only (delivery, preview, test). Public:
// what the UI gets (secrets masked). The UI sends masks back unchanged when a
// secret was not edited; mergeConnectorInput keeps the stored value then.

export const SECRET_MASK = "••••••"

export type SmtpSecurity = "starttls" | "tls" | "none"

export interface SmtpConfig {
  host: string
  port: number
  security: SmtpSecurity
  username: string
  password: string
  from: string
  to: string[]
  subjectTemplate: string
  bodyTemplate: string
}

export type ResolvedConnector =
  | { type: "webhook"; method: string; url: string; headers: Record<string, string>; bodyTemplate: string }
  | { type: "smtp"; smtp: SmtpConfig }

export type ConnectorInput =
  | { type: "webhook"; method: "POST" | "PUT"; url: string; headers: string; bodyTemplate: string }
  | { type: "smtp"; smtp: SmtpConfig }

export interface StoredConnectorFields {
  type: string
  method: string
  url: string
  headers: string
  bodyTemplate: string
  config: string
}

export interface PublicConnector {
  id: string
  name: string
  type: "webhook" | "smtp"
  enabled: boolean
  rateLimitPerMinute: number
  createdAt: Date
  method: string
  url: string
  headers: string
  bodyTemplate: string
  smtp: (Omit<SmtpConfig, "password"> & { passwordSet: boolean }) | null
  secretsUnreadable: boolean
}

export const DEFAULT_EMAIL_SUBJECT = "[HSI {{event.severity}}] {{event.source}}: {{event.target}}"
export const DEFAULT_EMAIL_BODY = `{{event.message}}

Type:     {{event.type}}
Severity: {{event.severity}}
Source:   {{event.source}}
Target:   {{event.target}}
Time:     {{event.time}}`

export const SMTP_PRESETS: Array<{ id: string; label: string; host: string; port: number; security: SmtpSecurity }> = [
  { id: "generic", label: "Generic SMTP", host: "", port: 587, security: "starttls" },
  { id: "gmail", label: "Gmail (app password)", host: "smtp.gmail.com", port: 587, security: "starttls" },
  { id: "fastmail", label: "Fastmail", host: "smtp.fastmail.com", port: 465, security: "tls" },
]

const isPublicHeader = (name: string) => name.toLowerCase() === "content-type"

export function maskUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`
  } catch {
    return SECRET_MASK
  }
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseSmtp(config: string): SmtpConfig {
  const c = parseObject(config)
  return {
    host: String(c.host ?? ""),
    port: Number(c.port ?? 587),
    security: (["starttls", "tls", "none"].includes(String(c.security)) ? c.security : "starttls") as SmtpSecurity,
    username: String(c.username ?? ""),
    password: String(c.password ?? ""),
    from: String(c.from ?? ""),
    to: Array.isArray(c.to) ? c.to.map(String) : [],
    subjectTemplate: String(c.subjectTemplate ?? DEFAULT_EMAIL_SUBJECT),
    bodyTemplate: String(c.bodyTemplate ?? DEFAULT_EMAIL_BODY),
  }
}

export function resolveStored(row: StoredConnectorFields, key: Buffer | null | undefined = secretsKey()): ResolvedConnector {
  if (row.type === "smtp") {
    const smtp = parseSmtp(row.config)
    return { type: "smtp", smtp: { ...smtp, password: smtp.password ? revealSecret(smtp.password, key) : "" } }
  }
  const headers = Object.fromEntries(
    Object.entries(parseObject(row.headers)).map(([k, v]) => [k, revealSecret(String(v ?? ""), key)]),
  )
  return { type: "webhook", method: row.method || "POST", url: row.url ? revealSecret(row.url, key) : "", headers, bodyTemplate: row.bodyTemplate }
}

function assertHttpUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("URL must be a valid http(s) URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL must be a valid http(s) URL")
}

export function mergeConnectorInput(input: ConnectorInput, stored: ResolvedConnector | null): ResolvedConnector {
  if (input.type === "smtp") {
    const prev = stored?.type === "smtp" ? stored.smtp : null
    const keep = input.smtp.password === "" || input.smtp.password === SECRET_MASK
    // An empty password on a new connector means "no authentication".
    if (input.smtp.password === SECRET_MASK && !prev) throw new SecretsError(UNREADABLE_SECRETS)
    return { type: "smtp", smtp: { ...input.smtp, password: keep ? (prev?.password ?? "") : input.smtp.password } }
  }

  const prev = stored?.type === "webhook" ? stored : null
  let url = input.url.trim()
  // "<origin>/…" is what maskUrl shows; it is never a real target.
  const masked = url === "" || url === SECRET_MASK || url.endsWith("/…")
  if (masked) {
    if (!prev) throw new SecretsError(UNREADABLE_SECRETS)
    url = prev.url
  } else {
    assertHttpUrl(url)
  }

  const headers: Record<string, string> = {}
  for (const [k, raw] of Object.entries(parseObject(input.headers))) {
    const v = String(raw ?? "")
    if (v === SECRET_MASK && !isPublicHeader(k)) {
      if (prev?.headers[k] === undefined) throw new SecretsError(UNREADABLE_SECRETS)
      headers[k] = prev.headers[k]!
    } else {
      headers[k] = v
    }
  }
  return { type: "webhook", method: input.method, url, headers, bodyTemplate: input.bodyTemplate }
}

export function toStoredFields(resolved: ResolvedConnector, key: Buffer | null | undefined = secretsKey()): StoredConnectorFields {
  if (resolved.type === "smtp") {
    const { password, ...rest } = resolved.smtp
    return {
      type: "smtp", method: "POST", url: "", headers: "{}", bodyTemplate: "",
      config: JSON.stringify({ ...rest, password: password ? encryptSecret(password, key) : "" }),
    }
  }
  const headers = Object.fromEntries(
    Object.entries(resolved.headers).map(([k, v]) => [k, isPublicHeader(k) ? v : encryptSecret(v, key)]),
  )
  return {
    type: "webhook", method: resolved.method, url: encryptSecret(resolved.url, key),
    headers: JSON.stringify(headers), bodyTemplate: resolved.bodyTemplate, config: "{}",
  }
}

export function toPublicConnector<T extends StoredConnectorFields & { id: string; name: string; enabled: boolean; rateLimitPerMinute: number; createdAt: Date }>(
  row: T, key: Buffer | null | undefined = secretsKey(),
): PublicConnector {
  const base = {
    id: row.id, name: row.name, enabled: row.enabled, rateLimitPerMinute: row.rateLimitPerMinute, createdAt: row.createdAt,
    method: row.method, bodyTemplate: row.bodyTemplate,
  }
  let resolved: ResolvedConnector | null
  try {
    resolved = resolveStored(row, key)
  } catch {
    resolved = null
  }
  if (row.type === "smtp") {
    const { password, ...rest } = parseSmtp(row.config)
    return { ...base, type: "smtp", url: "", headers: "{}", smtp: { ...rest, passwordSet: password !== "" }, secretsUnreadable: resolved === null }
  }
  const headers = Object.fromEntries(
    Object.entries(parseObject(row.headers)).map(([k, v]) => [k, isPublicHeader(k) ? String(v ?? "") : SECRET_MASK]),
  )
  return {
    ...base, type: "webhook",
    url: resolved?.type === "webhook" ? maskUrl(resolved.url) : SECRET_MASK,
    headers: JSON.stringify(headers), smtp: null, secretsUnreadable: resolved === null,
  }
}

// Boot-time, idempotent: converts pre-queue journal rows and encrypts
// connector secrets stored in plaintext by earlier versions.
export async function migrateNotificationStorage(): Promise<void> {
  await prisma.notificationDelivery.updateMany({ where: { status: "legacy", ok: true }, data: { status: "sent" } })
  await prisma.notificationDelivery.updateMany({ where: { status: "legacy" }, data: { status: "failed" } })

  const key = secretsKey()
  const rows = await prisma.notificationConnector.findMany()
  const legacy = rows.filter(r => r.type === "webhook" && r.url !== "" && !isEncrypted(r.url))
  if (legacy.length === 0) return
  if (!key) {
    log.warn({ count: legacy.length }, "notifications: HSI_SECRETS_KEY missing, connector secrets stay unencrypted")
    return
  }
  for (const row of legacy) {
    const fields = toStoredFields(resolveStored(row, key), key)
    await prisma.notificationConnector.update({ where: { id: row.id }, data: fields })
  }
  log.info({ count: legacy.length }, "notifications: encrypted legacy connector secrets")
}
