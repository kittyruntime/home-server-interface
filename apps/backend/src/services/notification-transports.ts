import nodemailer from "nodemailer"
import type { ResolvedConnector, SmtpConfig } from "./notification-connectors"
import { eventVars, interpolatePlain, renderWebhookRequest, type NotificationEvent, type WebhookRequest } from "./notifications"

// One delivery attempt per call. Retries and backoff belong to the delivery
// queue (notification-queue.ts), so a slow target never blocks a caller.

export interface DeliveryResult { ok: boolean; status?: number; error?: string }

const TIMEOUT_MS = 10_000

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function sendWebhook(req: WebhookRequest, fetchImpl: typeof fetch = fetch): Promise<DeliveryResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal })
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  } finally {
    clearTimeout(timer)
  }
}

export interface RenderedEmail { from: string; to: string[]; subject: string; text: string }

export function renderEmail(smtp: SmtpConfig, event: NotificationEvent): RenderedEmail {
  const vars = eventVars(event)
  return {
    from: smtp.from,
    to: smtp.to,
    // Event fields come from disks, paths and remote hosts: never let them
    // start a new header line.
    subject: interpolatePlain(smtp.subjectTemplate, vars).replace(/[\r\n]+/g, " ").trim(),
    text: interpolatePlain(smtp.bodyTemplate, vars),
  }
}

export interface MailSender {
  sendMail(mail: { from: string; to: string[]; subject: string; text: string }): Promise<unknown>
}

function smtpSender(smtp: SmtpConfig): MailSender {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    ignoreTLS: smtp.security === "none",
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  })
}

export async function sendEmail(smtp: SmtpConfig, event: NotificationEvent, sender: MailSender = smtpSender(smtp)): Promise<DeliveryResult> {
  try {
    await sender.sendMail(renderEmail(smtp, event))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

// Secret values a transport error must never repeat: errors are shown in the
// browser and stored in the delivery journal.
function secretsOf(connector: ResolvedConnector): string[] {
  if (connector.type === "smtp") return [connector.smtp.password]
  const values = Object.entries(connector.headers).filter(([k]) => k.toLowerCase() !== "content-type").map(([, v]) => v)
  let path = ""
  try {
    const u = new URL(connector.url)
    path = u.pathname + u.search
  } catch { /* unparsable URL: scrub it whole */ }
  return [connector.url, path.length > 1 ? path : "", ...values]
}

function scrub(message: string, secrets: string[]): string {
  let out = message
  for (const s of secrets.filter(v => v.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(s).join("••••••")
  return out
}

export async function deliverResolved(
  connector: ResolvedConnector,
  event: NotificationEvent,
  deps: { fetchImpl?: typeof fetch; sender?: MailSender } = {},
): Promise<DeliveryResult> {
  let result: DeliveryResult
  if (connector.type === "smtp") {
    result = await sendEmail(connector.smtp, event, deps.sender)
  } else {
    const req = renderWebhookRequest(
      { method: connector.method, url: connector.url, headers: JSON.stringify(connector.headers), bodyTemplate: connector.bodyTemplate },
      event,
    )
    result = await sendWebhook(req, deps.fetchImpl)
  }
  return result.error ? { ...result, error: scrub(result.error, secretsOf(connector)) } : result
}
