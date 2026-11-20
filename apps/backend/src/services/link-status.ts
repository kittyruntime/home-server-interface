import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

// Whether the services an admin pinned on a dashboard answer. Only the status
// line is read: no body, no redirect followed. Self-signed certificates are
// accepted, since local services often use one: this says "it answers", not
// "it is trusted".

export type LinkStatus = { url: string; up: boolean; status: number | null; ms: number | null }

export function checkableUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    return u.protocol === "http:" || u.protocol === "https:" ? u : null
  } catch { return null }
}

/** Any HTTP answer below 500 means the service is up (401 and 403 included). */
export const isUp = (status: number | null) => status != null && status < 500

export function checkUrl(raw: string, timeoutMs = 4000): Promise<LinkStatus> {
  const u = checkableUrl(raw)
  if (!u) return Promise.resolve({ url: raw, up: false, status: null, ms: null })
  const started = Date.now()
  return new Promise(resolve => {
    const done = (status: number | null) => resolve({ url: raw, up: isUp(status), status, ms: status == null ? null : Date.now() - started })
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method: "HEAD", timeout: timeoutMs, rejectUnauthorized: false }, res => {
      res.resume()
      done(res.statusCode ?? null)
    })
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", () => done(null))
    req.end()
  })
}

const cache = new Map<string, { at: number; value: LinkStatus }>()

export async function checkUrls(urls: string[], ttlMs = 30_000): Promise<LinkStatus[]> {
  const now = Date.now()
  return Promise.all(urls.map(async url => {
    const hit = cache.get(url)
    if (hit && now - hit.at < ttlMs) return hit.value
    const value = await checkUrl(url)
    cache.set(url, { at: Date.now(), value })
    if (cache.size > 500) cache.delete(cache.keys().next().value!)
    return value
  }))
}
