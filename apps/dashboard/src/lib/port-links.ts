// Published ports as links to the app: http on the server's LAN address, or
// the address recorded for the port behind the admin's own reverse proxy.

export interface LinkablePort {
  hostPort: number
  protocol?: string
  domain?: string
  tls?: boolean
  publicPort?: number
}

/** The URL a published port is opened at, or null for a UDP port. */
export function portUrl(port: LinkablePort, host: string): string | null {
  if (port.protocol === 'udp') return null
  if (port.domain) {
    const scheme = port.tls ? 'https' : 'http'
    return `${scheme}://${port.domain}${port.publicPort ? `:${port.publicPort}` : ''}/`
  }
  if (!host) return null
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${h}:${port.hostPort}/`
}
