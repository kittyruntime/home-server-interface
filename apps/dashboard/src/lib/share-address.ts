// How to reach an SMB share from each system. The network name comes first
// when the NAS announces itself (WS-Discovery for Windows, Bonjour for
// macOS and Linux); otherwise the address the browser used to reach HSI.

export type ShareOs = 'windows' | 'macos' | 'linux'

export interface ShareAddressInput {
  host: string
  share: string
  netbiosName?: string
  wsd?: boolean
  mdns?: boolean
}

const isIpv6 = (h: string) => h.includes(':')

// Windows paths cannot hold an IPv6 address; Microsoft's literal name does.
function windowsHost(h: string): string {
  return isIpv6(h) ? `${h.replace(/:/g, '-').replace(/%/g, 's')}.ipv6-literal.net` : h
}

function urlHost(h: string): string {
  return isIpv6(h) ? `[${h}]` : h
}

export function shareAddresses(o: ShareAddressInput): { os: ShareOs; address: string }[] {
  const name = o.netbiosName?.trim()
  const win = name && o.wsd ? name : windowsHost(o.host)
  const url = name && o.mdns ? `${name}.local` : urlHost(o.host)
  const path = encodeURIComponent(o.share)
  return [
    { os: 'windows', address: `\\\\${win}\\${o.share}` },
    { os: 'macos', address: `smb://${url}/${path}` },
    { os: 'linux', address: `smb://${url}/${path}` },
  ]
}

export interface NfsAddressInput { host: string; path: string; share: string }

const shellQuote = (s: string) => (/^[A-Za-z0-9_@%+=:,./[\]-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** How to mount an NFS export: a command for Linux, an address for the macOS Finder. */
export function nfsAddresses(o: NfsAddressInput): { os: 'linux' | 'macos'; address: string }[] {
  const host = urlHost(o.host)
  const encoded = o.path.split('/').map(encodeURIComponent).join('/')
  return [
    { os: 'linux', address: `sudo mount -t nfs ${shellQuote(`${host}:${o.path}`)} ${shellQuote(`/mnt/${o.share}`)}` },
    { os: 'macos', address: `nfs://${host}${encoded}` },
  ]
}
