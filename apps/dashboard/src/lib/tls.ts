export type TlsMode = 'local' | 'imported' | 'proxy' | 'off'

export function modeLabel(m: TlsMode): string {
  switch (m) {
    case 'local': return 'HTTPS, local authority'
    case 'imported': return 'HTTPS, imported certificate'
    case 'proxy': return 'Behind a reverse proxy'
    case 'off': return 'Plain HTTP'
  }
}

export function expiryState(notAfter: string, now: Date): { level: 'ok' | 'soon' | 'expired'; days: number } {
  const ms = new Date(notAfter).getTime() - now.getTime()
  const days = Math.floor(ms / 86_400_000)
  if (ms < 0) return { level: 'expired', days }
  return { level: days < 30 ? 'soon' : 'ok', days }
}

function bracket(host: string): string {
  return host.includes(':') && !host.includes('[') ? `[${host}]` : host
}

export interface NextAddress {
  /** The mode before the plan: tells who served the current page. */
  from: TlsMode
  https: boolean
  port: number
  standardPorts: boolean
}

type PageLocation = { protocol: string; hostname: string; port: string; pathname: string }

/** The URL to load once a plan changed the scheme or the ports. */
export function addressAfter(loc: PageLocation, next: NextAddress): string {
  const host = bracket(loc.hostname)
  if (next.https) {
    return next.standardPorts ? `https://${host}${loc.pathname}` : `https://${host}:${next.port}${loc.pathname}`
  }
  const port = loc.port ? `:${loc.port}` : ''
  // Still behind the admin's proxy: the page's origin (its scheme too) stays the way in.
  if (next.from === 'proxy') return `${loc.protocol}//${host}${port}${loc.pathname}`
  // Leaving HTTPS served by HSI itself: HSI now answers plain HTTP on its own port.
  if (loc.protocol === 'https:') return `http://${host}:${next.port}${loc.pathname}`
  // Already plain HTTP: stay where the page is.
  return `http://${host}${port}${loc.pathname}`
}

export interface WaitOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  fetch?: (url: string, init: RequestInit) => Promise<unknown>
  /** The protocol of the page that waits (defaults to the current page's). */
  pageProtocol?: string
}

const RESTART_DELAY_MS = 3_000
/** From an https page to an http target: the restart delay plus a grace. */
const BLIND_WAIT_MS = 10_000

/**
 * Waits for the server to answer after a restart. The old process is still up
 * for about 2 s, so the first poll waits 3 s. Never rejects; gives up at
 * timeoutMs and lets the navigation that follows show what the browser shows.
 *
 * - An https target from an http page: its certificate may not be trusted yet,
 *   so the plain http origin on the same port is probed instead. Once the new
 *   HTTPS server is up it answers there with a 308, seen as an
 *   "opaqueredirect" response; the old plain HTTP server answers normally and
 *   a server that is down makes the fetch reject.
 * - An http target from an https page: the browser blocks the fetch (mixed
 *   content), so it waits a fixed delay.
 * - Otherwise the target's `/health` is polled until it answers.
 */
export async function waitForServer(origin: string, timeoutMs = 60_000, opts: WaitOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const page = opts.pageProtocol ?? (typeof location !== 'undefined' ? location.protocol : 'http:')
  const target = new URL(origin)
  const start = now()
  if (page === 'https:' && target.protocol === 'http:') {
    await sleep(Math.min(BLIND_WAIT_MS, timeoutMs))
    return
  }
  const probeRedirect = target.protocol === 'https:' && page !== 'https:'
  const url = probeRedirect
    ? `http://${target.hostname}:${target.port || '443'}/health`
    : `${target.origin}/health`
  await sleep(RESTART_DELAY_MS)
  while (now() - start < timeoutMs) {
    try {
      const init: RequestInit = { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(1500) }
      if (probeRedirect) init.redirect = 'manual'
      const res = await doFetch(url, init)
      if (!probeRedirect || (res as { type?: string } | null)?.type === 'opaqueredirect') return
    } catch {
      // down: try again
    }
    await sleep(1_000)
  }
}

export interface OpenAfterRestartDeps {
  wait?: (origin: string) => Promise<void>
  assign?: (url: string) => void
}

/** Waits for HSI to come back at its new address after a plan, then loads it. */
export async function openAfterRestart(loc: PageLocation, next: NextAddress, deps: OpenAfterRestartDeps = {}): Promise<void> {
  const url = addressAfter(loc, next)
  await (deps.wait ?? (o => waitForServer(o, 60_000, { pageProtocol: loc.protocol })))(new URL(url).origin)
  ;(deps.assign ?? (u => location.assign(u)))(url)
}

export const TRUST_STEPS: Array<{ os: string; steps: string }> = [
  { os: 'Windows', steps: 'Open the downloaded file, choose Install Certificate, pick Local Machine, then place it in Trusted Root Certification Authorities.' },
  { os: 'macOS', steps: 'Open the file to add it to Keychain Access, then double-click it and set Trust to Always Trust.' },
  { os: 'Linux', steps: 'Copy the file to /usr/local/share/ca-certificates/ and run sudo update-ca-certificates. Firefox keeps its own list: import it under Settings, Certificates.' },
  { os: 'Android', steps: 'Open Settings, Security, Encryption and credentials, Install a certificate, CA certificate, and pick the file.' },
  { os: 'iOS', steps: 'Open the file to install the profile in Settings, then enable it under Settings, General, About, Certificate Trust Settings.' },
]
