import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

// Whether the services an admin pinned on a dashboard answer. Only the status
// line is read: no body, no redirect followed. Certificates are checked; a
// service whose certificate is not trusted (self-signed, as local services
// often are, or expired) still answered, and is reported as such.

export type LinkStatus = { url: string; up: boolean; status: number | null; ms: number | null; untrusted?: boolean }

const CERT_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID',
])

/** A TLS error that means the server answered with a certificate we do not trust. */
export const isCertificateError = (code: string | undefined) => !!code && CERT_ERRORS.has(code)

export function checkableUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
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
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: 'HEAD', timeout: timeoutMs }, res => {
      res.resume()
      done(res.statusCode ?? null)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (isCertificateError(e.code)) resolve({ url: raw, up: true, status: null, ms: Date.now() - started, untrusted: true })
      else done(null)
    })
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
