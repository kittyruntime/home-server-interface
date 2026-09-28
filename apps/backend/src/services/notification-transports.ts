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

export function deliverResolved(
  connector: ResolvedConnector,
  event: NotificationEvent,
  deps: { fetchImpl?: typeof fetch; sender?: MailSender } = {},
): Promise<DeliveryResult> {
  if (connector.type === "smtp") return sendEmail(connector.smtp, event, deps.sender)
  const req = renderWebhookRequest(
    { method: connector.method, url: connector.url, headers: JSON.stringify(connector.headers), bodyTemplate: connector.bodyTemplate },
    event,
  )
  return sendWebhook(req, deps.fetchImpl)
}
