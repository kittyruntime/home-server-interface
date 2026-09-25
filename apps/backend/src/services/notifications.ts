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
      for (const id of JSON.parse(rule.connectorIds) as string[]) ids.add(id)
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