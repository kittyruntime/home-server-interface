import { prisma } from "@app/database"
import { log } from "../utils/log"
import { enqueueDeliveries } from "./notification-queue"

// Notification engine core: pure functions (interpolation, rule matching,
// webhook request rendering). Transport and persistence live in the
// dispatcher section below; keeping the pure part separate makes it testable
// without a database.

export type Severity = "info" | "warning" | "critical"

export interface NotificationEvent {
  // job.failed: a one-off failure (e.g. a backup run) with nothing to clear later.
  // update.failed: an HSI update that did not end on the requested version.
  type: "alert.raised" | "alert.cleared" | "job.failed" | "update.failed"
  severity: Severity
  source: string
  target: string
  message: string
  time: string
}

export const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 }

// Replace {{vars}} with JSON-escaped values (a message containing quotes or
// newlines must never break a JSON body). Unknown variables are left as-is:
// they are immediately visible in the Send test result.
export function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (match, key: string) => {
    const value = vars[key]
    if (value === undefined) return match
    return JSON.stringify(value).slice(1, -1)
  })
}

// Same variables without JSON escaping, for plain-text targets (email).
export function interpolatePlain(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (match, key: string) => vars[key] ?? match)
}

export function ruleMatches(
  rule: { sourcePrefix: string; minSeverity: string; enabled: boolean },
  event: NotificationEvent,
): boolean {
  if (!rule.enabled) return false
  if (!event.source.startsWith(rule.sourcePrefix)) return false
  return (SEVERITY_RANK[event.severity] ?? 0) >= (SEVERITY_RANK[rule.minSeverity] ?? 0)
}

// Returns the unique connector ids targeted by all enabled rules that match
// the event. `connectorIds` is a JSON array string per rule.
export function selectConnectorIds(
  rules: Array<{ sourcePrefix: string; minSeverity: string; enabled: boolean; connectorIds: string }>,
  event: NotificationEvent,
): string[] {
  const ids = new Set<string>()
  for (const rule of rules) {
    if (!ruleMatches(rule, event)) continue
    try {
      // Shape guard: accept only a JSON array of strings; a wrong-shape row
      // ("w1", {"w1": true}, numbers) must not slip through (a bare string
      // would iterate as characters).
      const parsed = JSON.parse(rule.connectorIds) as unknown
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === "string") ids.add(id)
        }
      }
    } catch { /* corrupted rule row: skip its targets */ }
  }
  return [...ids]
}

export function eventVars(event: NotificationEvent): Record<string, string> {
  return {
    "event.type": event.type,
    "event.severity": event.severity,
    "event.source": event.source,
    "event.target": event.target,
    "event.message": event.message,
    "event.time": event.time,
  }
}

export interface WebhookRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

export function renderWebhookRequest(
  connector: { method: string; url: string; headers: string; bodyTemplate: string },
  event: NotificationEvent,
): WebhookRequest {
  const vars = eventVars(event)
  let headers: Record<string, string> = {}
  try {
    const parsed = JSON.parse(connector.headers) as Record<string, unknown>
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, interpolateTemplate(String(v), vars)]))
    }
  } catch { /* degrade to no headers */ }
  return {
    method: connector.method || "POST",
    url: connector.url,
    headers,
    body: interpolateTemplate(connector.bodyTemplate, vars),
  }
}

// ---------------------------------------------------------------------------
// Dispatcher: routes an event to the in-app bell and to the delivery queue
// (notification-queue.ts). Transports live in notification-transports.ts.
// ---------------------------------------------------------------------------

export const IN_APP_CONNECTOR_ID = "inapp"

// Fixed sample used by preview + Send test.
export function sampleEvent(): NotificationEvent {
  return {
    type: "alert.raised",
    severity: "warning",
    source: "storage.disk-usage",
    target: "/srv/data",
    message: "Disk usage: 84.2% (warning, threshold 80%)",
    time: new Date().toISOString(),
  }
}

export interface WebhookPreset {
  id: string
  label: string
  method: string
  url: string
  headers: string
  bodyTemplate: string
}

// Presets prefill the connector dialog; everything stays editable after.
export const WEBHOOK_PRESETS: WebhookPreset[] = [
  {
    id: "custom",
    label: "Custom (HSI JSON)",
    method: "POST",
    url: "",
    headers: '{"Content-Type":"application/json"}',
    bodyTemplate: `{
  "type": "{{event.type}}",
  "severity": "{{event.severity}}",
  "source": "{{event.source}}",
  "target": "{{event.target}}",
  "message": "{{event.message}}",
  "time": "{{event.time}}"
}`,
  },
  {
    id: "discord",
    label: "Discord",
    method: "POST",
    url: "",
    headers: '{"Content-Type":"application/json"}',
    bodyTemplate: `{"content":"[{{event.severity}}] {{event.source}}: {{event.message}} ({{event.target}})"}`,
  },
  {
    id: "slack",
    label: "Slack",
    method: "POST",
    url: "",
    headers: '{"Content-Type":"application/json"}',
    bodyTemplate: `{"text":"[{{event.severity}}] {{event.source}}: {{event.message}} ({{event.target}})"}`,
  },
  {
    id: "ntfy",
    label: "ntfy",
    method: "POST",
    url: "https://ntfy.sh",
    headers: '{"Content-Type":"application/json"}',
    bodyTemplate: `{"topic":"YOUR_TOPIC","title":"HSI {{event.severity}}: {{event.source}}","message":"{{event.message}}"}`,
  },
]

const RULES_CACHE_TTL_MS = 30_000
let rulesCache: { rules: Array<{ id: string; name: string; sourcePrefix: string; minSeverity: string; connectorIds: string; enabled: boolean }>; connectorIds: Set<string>; at: number } | null = null

async function loadConfig() {
  if (rulesCache && Date.now() - rulesCache.at < RULES_CACHE_TTL_MS) return rulesCache
  const [rules, connectors] = await Promise.all([
    prisma.notificationRule.findMany({ where: { enabled: true } }),
    prisma.notificationConnector.findMany({ where: { enabled: true }, select: { id: true } }),
  ])
  rulesCache = { rules, connectorIds: new Set(connectors.map(c => c.id)), at: Date.now() }
  return rulesCache
}

async function deliverInApp(event: NotificationEvent): Promise<void> {
  await prisma.notification.create({
    data: { severity: event.severity, source: event.source, target: event.target, message: event.message, eventType: event.type },
  })
  // Prune: keep the 200 most recent rows.
  const keep = await prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: 200, select: { createdAt: true } })
  if (keep.length === 200) {
    await prisma.notification.deleteMany({ where: { createdAt: { lt: keep[keep.length - 1]!.createdAt } } })
  }
}

// Fire-and-forget entry point: callers do NOT await this in the sampling path.
// In-app notifications are written immediately; external connectors go
// through the persistent delivery queue.
export async function dispatchEvent(event: NotificationEvent): Promise<void> {
  try {
    const config = await loadConfig()
    const ids = selectConnectorIds(config.rules, event)
    if (ids.includes(IN_APP_CONNECTOR_ID)) {
      try {
        await deliverInApp(event)
      } catch (e) {
        log.error({ err: e }, "notifications: in-app delivery failed")
      }
    }
    await enqueueDeliveries(ids.filter(id => id !== IN_APP_CONNECTOR_ID && config.connectorIds.has(id)), event)
  } catch (e) {
    log.error({ err: e }, "notifications: dispatch failed") // never crash the caller
  }
}

// First boot: make the bell useful immediately.
export async function ensureDefaultRule(): Promise<void> {
  const count = await prisma.notificationRule.count()
  if (count === 0) {
    await prisma.notificationRule.create({
      data: { name: "All alerts", sourcePrefix: "", minSeverity: "warning", connectorIds: JSON.stringify([IN_APP_CONNECTOR_ID]), enabled: true },
    })
  }
}
