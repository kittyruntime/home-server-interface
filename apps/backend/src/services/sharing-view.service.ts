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
}

/** The enabled shares the viewer can open, with what they may do there. */
export async function reachableShares(prisma: PrismaClient, v: Viewer): Promise<ReachableShare[]> {
  const shares = await prisma.share.findMany({
    where: { enabled: true },
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
    out.push({ id: s.id, name: effectiveSmbName(s, s.place.name), level: write ? "write" : "read", guestOk: s.guestOk, hidden: s.hidden })
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
