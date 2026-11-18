import { isIP } from "node:net"

// NFS has no sign-in: an export trusts the client addresses listed on the
// share. These are checked here as the admin types them, and again by the
// worker before anything is written.

export const MAX_NFS_CLIENTS = 16

function normalize(entry: string): string | null {
  const [addr, prefix, extra] = entry.split("/")
  if (extra !== undefined) return null
  const family = isIP(addr)
  if (family === 0) return null
  if (prefix === undefined) return addr.toLowerCase()
  if (!/^[0-9]{1,3}$/.test(prefix)) return null
  const n = Number(prefix)
  if (n < 1 || n > (family === 4 ? 32 : 128)) return null
  return `${addr.toLowerCase()}/${n}`
}

/** The client list of a share, or why it is refused. Commas or spaces separate entries. */
export function parseNfsClients(raw: string): { clients: string[] } | { error: string } {
  const entries = raw.split(/[\s,]+/).filter(Boolean)
  if (entries.length === 0) return { error: "List at least one address or network allowed to mount it" }
  if (entries.length > MAX_NFS_CLIENTS) return { error: `At most ${MAX_NFS_CLIENTS} addresses or networks` }
  const clients: string[] = []
  for (const e of entries) {
    const n = normalize(e)
    if (!n) return { error: `"${e}" is not an address or a network like 192.168.1.0/24 (every address is refused)` }
    clients.push(n)
  }
  return { clients }
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, p) => acc * 256 + Number(p), 0)
}

function plainV4(ip: string): string {
  return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip
}

/** Whether a client address is one of the allowed entries (IPv6 networks: exact address only). */
export function clientAllowed(ip: string, allowed: string[]): boolean {
  const addr = plainV4(ip.toLowerCase())
  return allowed.some(a => {
    const [net, prefix] = a.split("/")
    if (prefix === undefined) return net === addr
    if (isIP(net) !== 4 || isIP(addr) !== 4) return false
    const bits = Number(prefix)
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return ((v4ToInt(net) & mask) >>> 0) === ((v4ToInt(addr) & mask) >>> 0)
  })
}

/** The admin's own /24 when they sit on a private IPv4 network, else "". */
export function suggestNfsClients(callerIp: string | undefined): string {
  if (!callerIp) return ""
  const ip = plainV4(callerIp)
  if (isIP(ip) !== 4) return ""
  const [a, b, c] = ip.split(".").map(Number)
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  return isPrivate ? `${a}.${b}.${c}.0/24` : ""
}
