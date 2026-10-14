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
  // Plain HTTP: keep the port the page was served on, unless it was the HSI port itself.
  const port = loc.port ? `:${loc.port}` : ''
  return `http://${host}${port}${loc.pathname}`
}

/**
 * Polls `${origin}/health` until something answers. A certificate the browser
 * does not trust yet makes every fetch fail, so it also resolves after 8
 * seconds without an answer: the navigation that follows then shows the
 * browser's own certificate warning, which is the expected first step.
 * Never rejects.
 */
export async function waitForServer(origin: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  const untrustedAfter = 8_000
  while (Date.now() - start < Math.min(timeoutMs, untrustedAfter)) {
    try {
      await fetch(`${origin}/health`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(1500) })
      return
    } catch {
      await new Promise(r => setTimeout(r, 1000))
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
