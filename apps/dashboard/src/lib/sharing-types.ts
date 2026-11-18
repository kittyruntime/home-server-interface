import type { trpc } from './trpc'

export type SharingService = Awaited<ReturnType<typeof trpc.sharing.service.query>>
export type ShareListRow = Awaited<ReturnType<typeof trpc.sharing.list.query>>[number]
export type ShareDetailData = Awaited<ReturnType<typeof trpc.sharing.detail.query>>
export type ShareEventRow = Awaited<ReturnType<typeof trpc.sharing.events.query>>['items'][number]
export type ShareSession = Awaited<ReturnType<typeof trpc.sharing.sessions.query>>[number]

/** What the connection addresses need from the service settings. */
/** `host`: the server's address on the local network, when known. */
export interface ConnectInfo { netbiosName?: string; wsd?: boolean; mdns?: boolean; host?: string }

/** Where SMB and NFS clients reach the NAS: its local address, else the one the browser used. */
export function shareHost(host?: string): string {
  return host || window.location.hostname
}

export function connectInfo(s: SharingService | null): ConnectInfo {
  if (!s) return {}
  return {
    netbiosName: s.settings.netbiosName,
    wsd: s.settings.discoveryWsd && !!s.state?.wsddOn,
    mdns: s.settings.discoveryMdns && !!s.state?.avahiOn,
    host: s.lanAddress || undefined,
  }
}
