import { requestSync } from "../nats"
import { log } from "../utils/log"
import { dispatchEvent, type NotificationEvent } from "./notifications"
import { readTlsConfig } from "./tls-config"

// Managed HTTPS (#12): once a day, the local authority's certificate is renewed
// when it nears its end or the server's names changed; an imported one raises
// notifications 30 and 7 days before it expires, and when it has.

const DAY = 24 * 3600_000

export function expiryNotice(notAfter: Date, now: Date, last: number | null): { threshold: 30 | 7 | 0; event: NotificationEvent } | null {
  const left = Math.floor((notAfter.getTime() - now.getTime()) / DAY)
  const threshold = left < 0 ? 0 : left <= 7 ? 7 : left <= 30 ? 30 : null
  if (threshold === null || (last !== null && last <= threshold)) return null
  const message = threshold === 0
    ? `The HTTPS certificate expired on ${notAfter.toISOString().slice(0, 10)}: browsers refuse it. Import a new one or go back to the local authority.`
    : `The HTTPS certificate expires in ${left} days (${notAfter.toISOString().slice(0, 10)}): import its renewal.`
  return { threshold, event: { type: "alert.raised", severity: threshold === 0 ? "critical" : "warning", source: "system.tls", target: "certificate", message, time: now.toISOString() } }
}

let lastThreshold: number | null = null

async function check() {
  const cfg = readTlsConfig()
  try {
    if (cfg.mode === "local") {
      const r = await requestSync<{ renewed: boolean; reason: string }>("root.tls.issue", {}, 30_000)
      if (r.renewed) log.info({ reason: r.reason }, "tls: certificate renewed")
    } else if (cfg.mode === "imported") {
      const st = await requestSync<{ certificate: { notAfter: string } | null }>("root.tls.status", {}, 10_000)
      if (!st.certificate) return
      const n = expiryNotice(new Date(st.certificate.notAfter), new Date(), lastThreshold)
      if (n) { lastThreshold = n.threshold; void dispatchEvent(n.event) }
    }
  } catch (err) {
    log.error({ err }, "tls: daily check failed")
  }
}

export function startTlsWatch() {
  void check()
  setInterval(() => void check(), DAY).unref()
}
