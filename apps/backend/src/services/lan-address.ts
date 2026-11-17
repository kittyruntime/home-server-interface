import { networkInterfaces } from "node:os"

// The address computers on the local network reach the NAS at. HSI is often
// opened through a domain name or a proxy that SMB and NFS clients cannot
// use, so the connect addresses use this one.

/** Interfaces of containers, VMs and VPNs: never the LAN. */
const VIRTUAL = /^(lo|docker|br-|veth|virbr|vnet|lxc|lxd|cni|flannel|cali|tun|tap|wg|tailscale|zt|podman)/

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

const toInt = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0) >>> 0

/** The server's private IPv4 address on a physical interface, or "". With
 *  several, the one on the viewer's own network. */
export function lanAddress(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(), viewerIp?: string): string {
  const candidates = Object.entries(ifaces)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, addrs]) => (addrs ?? []).filter(a => a.family === "IPv4" && !a.internal && isPrivateV4(a.address)))
  const viewer = viewerIp?.replace(/^::ffff:/, "")
  if (viewer && /^\d+\.\d+\.\d+\.\d+$/.test(viewer)) {
    const same = candidates.find(a => ((toInt(a.address) ^ toInt(viewer)) & toInt(a.netmask)) === 0)
    if (same) return same.address
  }
  return candidates[0]?.address ?? ""
}
