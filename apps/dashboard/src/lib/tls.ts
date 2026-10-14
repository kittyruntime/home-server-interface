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

/** The URL to load once a plan changed the scheme or the ports. */
export function addressAfter(
  loc: { protocol: string; hostname: string; port: string; pathname: string },
  next: { https: boolean; port: number; standardPorts: boolean },
): string {
  const host = bracket(loc.hostname)
  if (next.https) {
    return next.standardPorts ? `https://${host}${loc.pathname}` : `https://${host}:${next.port}${loc.pathname}`
  }
  // Leaving HTTPS served by HSI itself: HSI now answers plain HTTP on its own port.
  if (loc.protocol === 'https:') return `http://${host}:${next.port}${loc.pathname}`
  // Already plain HTTP (for example a proxy on 80): stay where the page is.
  const port = loc.port ? `:${loc.port}` : ''
  return `http://${host}${port}${loc.pathname}`
}

export interface WaitOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  fetch?: (url: string, init: RequestInit) => Promise<unknown>
}

/**
 * Waits for the server to answer `${origin}/health` after a restart. The old
 * process is still up for about 2 s, so the first poll waits 3 s. An http
 * origin is polled until timeoutMs. A certificate the browser does not trust
 * yet makes every fetch to an https origin fail, so there it also resolves
 * after 8 seconds without an answer: the navigation that follows then shows
 * the browser's own certificate warning. Never rejects.
 */
export async function waitForServer(origin: string, timeoutMs = 60_000, opts: WaitOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const limit = origin.startsWith('https:') ? Math.min(timeoutMs, 8_000) : timeoutMs
  const start = now()
  await sleep(3_000)
  while (now() - start < limit) {
    try {
      await doFetch(`${origin}/health`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(1500) })
      return
    } catch {
      await sleep(1_000)
    }
  }
}

export const TRUST_STEPS: Array<{ os: string; steps: string }> = [
  { os: 'Windows', steps: 'Open the downloaded file, choose Install Certificate, pick Local Machine, then place it in Trusted Root Certification Authorities.' },
  { os: 'macOS', steps: 'Open the file to add it to Keychain Access, then double-click it and set Trust to Always Trust.' },
  { os: 'Linux', steps: 'Copy the file to /usr/local/share/ca-certificates/ and run sudo update-ca-certificates. Firefox keeps its own list: import it under Settings, Certificates.' },
  { os: 'Android', steps: 'Open Settings, Security, Encryption and credentials, Install a certificate, CA certificate, and pick the file.' },
  { os: 'iOS', steps: 'Open the file to install the profile in Settings, then enable it under Settings, General, About, Certificate Trust Settings.' },
]
