import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BlockList, isIP } from "node:net"

// Managed HTTPS (#12): how the backend serves, written by the root worker in
// tls.json. A missing or unreadable file means plain HTTP, as before.

export interface TlsConfig {
  mode: "local" | "imported" | "proxy" | "off"
  port: number
  standardPorts: boolean
  trustedProxies: string[]
}

export const tlsDir = () => process.env.HSI_TLS_DIR ?? "/var/lib/hsi/tls"
export const servesHttps = (c: TlsConfig) => c.mode === "local" || c.mode === "imported"

export function readTlsConfig(dir = tlsDir(), fallbackPort = 9001): TlsConfig {
  const off: TlsConfig = { mode: "off", port: fallbackPort, standardPorts: false, trustedProxies: [] }
  try {
    const raw = JSON.parse(readFileSync(join(dir, "tls.json"), "utf8"))
    if (!raw || typeof raw !== "object") return off
    const mode = ["local", "imported", "proxy", "off"].includes(raw.mode) ? raw.mode : "off"
    const port = Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : fallbackPort
    const trustedProxies = Array.isArray(raw.trustedProxies)
      ? raw.trustedProxies.filter((x: unknown): x is string => typeof x === "string")
      : []
    return { mode, port, standardPorts: raw.standardPorts === true, trustedProxies }
  } catch {
    return off
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

const family = (addr: string) => (isIP(addr) === 6 ? "ipv6" : "ipv4")

// Forwarded client addresses are trusted from loopback peers only, and in
// proxy mode also from the proxies the admin listed (IPs or CIDR ranges).
export function trustProxyFn(cfg: TlsConfig): (address: string) => boolean {
  const list = new BlockList()
  if (cfg.mode === "proxy") {
    for (const entry of cfg.trustedProxies) {
      const [addr = "", bits] = entry.trim().split("/")
      if (!isIP(addr)) continue
      try {
        if (bits !== undefined) list.addSubnet(addr, Number(bits), family(addr))
        else list.addAddress(addr, family(addr))
      } catch {
        // An invalid prefix length is ignored, never trusted.
      }
    }
  }
  return (address) => {
    if (LOOPBACK.has(address)) return true
    const plain = address.startsWith("::ffff:") ? address.slice(7) : address
    if (!isIP(plain)) return false
    return list.check(plain, family(plain))
  }
}
