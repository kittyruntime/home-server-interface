import { prisma } from "@app/database"

// Notification engine core: pure functions (interpolation, rule matching,
// webhook request rendering). Transport and persistence live in the
// dispatcher section below; keeping the pure part separate makes it testable
// without a database.

export type Severity = "info" | "warning" | "critical"

export interface NotificationEvent {
  type: "alert.raised" | "alert.cleared"
  severity: Severity
  source: string
  target: string
  message: string
  time: string
}

export const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 }

// Replace {{vars}} with JSON-escaped values (a message containing quotes or
// newlines must never break a JSON body). Unknown variables are left as-is —
// they are immediately visible in the Send test result.
export function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (match, key: string) => {
    const value = vars[key]
    if (value === undefined) return match
    return JSON.stringify(value).slice(1, -1)
  })
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
      // Shape guard: accept only a JSON array of strings — a wrong-shape row
      // ("w1", {"w1": true}, numbers) must not slip through (a bare string
      // would iterate as characters).
      const parsed = JSON.parse(rule.connectorIds) as unknown
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === "string") ids.add(id)
        }
      }
    } catch { /* corrupted rule row — skip its targets */ }
  }
  return [...ids]
}

function eventVars(event: NotificationEvent): Record<string, string> {
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
// Dispatcher: transport, persistence and delivery. Uses the pure functions
// above; the only DB-free entry points remain the pure helpers + attemptWebhook
// (fetch is injectable there).
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
    bodyTemplate: `{"content":"[{{event.severity}}] {{event.source}} — {{event.message}} ({{event.target}})"}`,
  },
  {
    id: "slack",
    label: "Slack",
    method: "POST",
    url: "",
    headers: '{"Content-Type":"application/json"}',
    bodyTemplate: `{"text":"[{{event.severity}}] {{event.source}} — {{event.message}} ({{event.target}})"}`,
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

// One transport attempt per call site loop. `fetchImpl` injectable for tests.
export interface AttemptOpts { delays?: number[]; fetchImpl?: typeof fetch }
export async function attemptWebhook(
  req: WebhookRequest,
  opts: AttemptOpts = {},
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const delays = opts.delays ?? [0, 2_000, 10_000]
  const doFetch = opts.fetchImpl ?? fetch
  let lastError = "unknown error"
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, delays[i - 1]))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await doFetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      })
      if (res.ok) return { ok: true, status: res.status }
      lastError = `HTTP ${res.status}`
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: lastError }
}

const RULES_CACHE_TTL_MS = 30_000
let rulesCache: { rules: Array<{ id: string; name: string; sourcePrefix: string; minSeverity: string; connectorIds: string; enabled: boolean }>; connectors: Array<{ id: string; name: string; type: string; method: string; url: string; headers: string; bodyTemplate: string; enabled: boolean }>; at: number } | null = null

async function loadConfig() {
  if (rulesCache && Date.now() - rulesCache.at < RULES_CACHE_TTL_MS) return rulesCache
  const [rules, connectors] = await Promise.all([
    prisma.notificationRule.findMany({ where: { enabled: true } }),
    prisma.notificationConnector.findMany({ where: { enabled: true } }),
  ])
  rulesCache = { rules, connectors, at: Date.now() }
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

async function deliverWebhook(connector: { id: string; method: string; url: string; headers: string; bodyTemplate: string }, event: NotificationEvent, test: boolean): Promise<void> {
  const req = renderWebhookRequest(connector, event)
  const result = await attemptWebhook(req)
  await prisma.notificationDelivery.create({
    data: { connectorId: connector.id, ok: result.ok, error: result.error ?? "", test },
  })
}

// Fire-and-forget entry point: callers do NOT await this in the sampling path.
export async function dispatchEvent(event: NotificationEvent, opts: { onlyConnectorId?: string; test?: boolean } = {}): Promise<void> {
  try {
    const config = await loadConfig()
    let ids = selectConnectorIds(config.rules, event)
    if (opts.onlyConnectorId) ids = ids.filter(id => id === opts.onlyConnectorId)
    for (const id of ids) {
      if (id === IN_APP_CONNECTOR_ID) {
        await deliverInApp(event)
      } else {
        const connector = config.connectors.find(c => c.id === id && c.enabled && c.type === "webhook")
        if (connector) await deliverWebhook(connector, event, opts.test ?? false)
      }
    }
  } catch (e) {
    console.error("notifications: dispatch failed:", e) // never crash the caller
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
