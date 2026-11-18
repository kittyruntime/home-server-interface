import type { PrismaClient } from "@app/database"
import { TRPCError } from "@trpc/server"
import { adminLinuxUsers, effectiveSmbName, resolveShareUsers } from "./sharing.service"
import { assertNotThrottled, clearLoginFailures, recordLoginFailure } from "./login-throttle"

// What a signed-in user may see of SMB. Admins see everything; anyone else
// sees the shares they can reach and only their own sessions and events.
// The username is also the Linux and Samba account name.

export interface Viewer { userId: string; username: string; isAdmin: boolean }

export async function viewerOf(prisma: PrismaClient, userId: string): Promise<Viewer> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, isAdmin: true } })
  if (!u) throw new TRPCError({ code: "UNAUTHORIZED" })
  return { userId, username: u.username, isAdmin: u.isAdmin }
}

export function visibleSessions<T extends { user: string }>(sessions: T[], v: Viewer): T[] {
  return v.isAdmin ? sessions : sessions.filter(s => s.user === v.username)
}

export interface SmbConnection { user: string; share: string; client: string; connectedAt: string; pid?: string; ip?: string; sessionId?: string }
export interface SmbSession extends SmbConnection { pids: string[] }

/**
 * One line per person, share and machine. A client opens several connections
 * for one mount (macOS opens one per window and per Finder task), which Samba
 * lists separately; they are one session to the person using it.
 */
export function groupSessions(conns: SmbConnection[]): SmbSession[] {
  const byKey = new Map<string, SmbSession>()
  for (const c of conns) {
    const key = `${c.share}\0${c.user}\0${(c.ip || c.client).toLowerCase()}`
    const g = byKey.get(key)
    if (!g) {
      byKey.set(key, { ...c, pids: c.pid ? [c.pid] : [] })
      continue
    }
    if (c.pid && !g.pids.includes(c.pid)) g.pids.push(c.pid)
    if (c.connectedAt < g.connectedAt) g.connectedAt = c.connectedAt
  }
  return [...byKey.values()].sort((a, b) => a.connectedAt.localeCompare(b.connectedAt))
}

/** Distinct people connected; a guest is told apart by address. */
export function peopleConnected(sessions: SmbConnection[]): number {
  return new Set(sessions.map(s => s.user || `@${s.ip || s.client}`)).size
}

/**
 * Distinct people on one share over every protocol: an account once however it
 * connects, a guest or an NFS machine by address.
 */
export function peopleOnShare(now: { smb: SmbConnection[]; nfs: string[]; sftp: string[] }): number {
  return new Set([
    ...now.smb.map(s => s.user || `@${s.ip || s.client}`),
    ...now.nfs.map(ip => `@${ip}`),
    ...now.sftp,
  ]).size
}

export interface EventFilter {
  share?: string
  user?: string
  result?: "ok" | "refused"
  since?: Date
  cursor?: string
  limit: number
}

/** Newest first; `nextCursor` continues after the last item. */
export async function listEvents(prisma: PrismaClient, v: Viewer, f: EventFilter) {
  const where = {
    ...(f.share && { share: f.share }),
    ...(v.isAdmin ? f.user && { user: f.user } : { user: v.username }),
    ...(f.result && { result: f.result }),
    ...(f.since && { at: { gte: f.since } }),
  }
  const rows = await prisma.shareEvent.findMany({
    where,
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: f.limit + 1,
    ...(f.cursor && { cursor: { id: f.cursor }, skip: 1 }),
  })
  const items = rows.slice(0, f.limit)
  return { items, nextCursor: rows.length > f.limit ? items[items.length - 1]?.id ?? null : null }
}

export interface ReachableShare {
  id: string
  name: string
  level: "read" | "write"
  guestOk: boolean
  hidden: boolean
  /** Offered over SMB and over SFTP. */
  smb: boolean
  sftp: boolean
}

/** The enabled shares the viewer can open, with what they may do there. */
export async function reachableShares(prisma: PrismaClient, v: Viewer): Promise<ReachableShare[]> {
  const shares = await prisma.share.findMany({
    // NFS has no sign-in: only what a person opens with their account.
    where: { enabled: true, OR: [{ smb: true }, { sftp: true }] },
    include: { place: { select: { name: true, path: true } } },
    orderBy: { createdAt: "asc" },
  })
  const admins = new Set(await adminLinuxUsers(prisma))
  const out: ReachableShare[] = []
  for (const s of shares) {
    const users = await resolveShareUsers(prisma, s.placeId)
    const valid = users.validUsers.includes(v.username) || admins.has(v.username)
    if (!valid && !s.guestOk) continue
    const write = !s.readOnly && valid && (users.writeUsers.includes(v.username) || admins.has(v.username))
    out.push({ id: s.id, name: effectiveSmbName(s, s.place.name), level: write ? "write" : "read", guestOk: s.guestOk, hidden: s.hidden, smb: s.smb ?? true, sftp: s.sftp ?? false })
  }
  return out
}

interface RepairDeps {
  verify(prisma: PrismaClient, userId: string, password: string): Promise<boolean>
  sync(prisma: PrismaClient, userId: string, password: string): Promise<boolean>
}

/** Writes the viewer's network password from their HSI password, once that
 *  password is proven; failures count like failed sign-ins. */
export async function repairNetworkPassword(prisma: PrismaClient, v: Viewer, password: string, ip: string | undefined, deps: RepairDeps) {
  const keys = [`user:${v.username.toLowerCase()}`, ...(ip ? [`ip:${ip}`] : [])]
  assertNotThrottled(keys)
  if (!await deps.verify(prisma, v.userId, password)) {
    recordLoginFailure(keys)
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Wrong password" })
  }
  clearLoginFailures([keys[0]])
  return { ok: await deps.sync(prisma, v.userId, password) }
}
