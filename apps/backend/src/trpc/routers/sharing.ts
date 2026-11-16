import { z } from "zod"
import { isIP } from "node:net"
import { TRPCError } from "@trpc/server"
import { router, adminProcedure, protectedProcedure } from "../index"
import { requestSync } from "../../nats"
import {
  resolveShareUsers,
  effectiveSmbName,
  adminLinuxUsers,
  shareExclusionReason,
  desiredShareDefs,
  currentSmbSettings,
  syncShares,
  withShareLock,
} from "../../services/sharing.service"
import {
  SHARE_OPS, applyShareChange, previewShareChange,
  type ShareChange, type ShareOp, type SharePlanDeps,
} from "../../services/sharing-plan"
import { planAuditMeta } from "../../services/storage-plan"
import { getSmbSettings, liftBlock, listBlocks, smbServiceState } from "../../services/smb-events.service"
import {
  groupSessions, listEvents, peopleConnected, reachableShares, repairNetworkPassword, viewerOf, visibleSessions,
  type SmbConnection, type SmbSession,
} from "../../services/sharing-view.service"
import { syncSystemPassword, verifyPassword } from "../../services/user.service"
import type { Context } from "../context"

type DirState = {
  path: string; exists: boolean; group: string; mode: string; setgid: boolean; groupWritable: boolean
}

const reSmbName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

/** Who is connected right now, one line per person, share and machine; nobody when Samba is missing or not answering. */
async function sessionsNow(): Promise<SmbSession[]> {
  try {
    return groupSessions((await requestSync<{ connections: SmbConnection[] }>("root.sharing.status", {})).connections ?? [])
  } catch {
    return []
  }
}

/** Accounts with a Samba password, and the state of the given folders. */
async function sambaFacts(paths: string[]): Promise<{ sambaUsers: Set<string>; dirs: Map<string, DirState> }> {
  try {
    const d = await requestSync<{ sambaUsers: string[]; dirs: DirState[] }>("root.sharing.diag", { paths })
    return { sambaUsers: new Set(d.sambaUsers ?? []), dirs: new Map((d.dirs ?? []).map(x => [x.path, x])) }
  } catch {
    return { sambaUsers: new Set(), dirs: new Map() }
  }
}

function callerIp(ctx: Context): string | undefined {
  return ctx.req.ip ?? ctx.req.headers["x-forwarded-for"]?.toString()
}

async function assertUniqueName(
  prisma: Parameters<typeof syncShares>[0],
  name: string,
  excludeShareId?: string,
): Promise<void> {
  const others = await prisma.share.findMany({
    where: excludeShareId ? { id: { not: excludeShareId } } : {},
    include: { place: { select: { name: true } } },
  })
  const taken = others.some(
    (s) => effectiveSmbName(s, s.place.name).toLowerCase() === name.toLowerCase(),
  )
  if (taken)
    throw new TRPCError({ code: "CONFLICT", message: `Share name "${name}" is already in use` })
}

const zShareInputs = {
  "share.create": z.object({
    placeId: z.string(),
    smbName: z.string().regex(reSmbName).optional(),
    readOnly: z.boolean().default(false),
    guestOk: z.boolean().default(false),
    hidden: z.boolean().default(false),
  }),
  "share.update": z.object({
    id: z.string(),
    enabled: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    guestOk: z.boolean().optional(),
    hidden: z.boolean().optional(),
    smbName: z.string().regex(reSmbName).nullable().optional(),
  }),
  "share.remove": z.object({ id: z.string() }),
  "smb.settings": z.object({
    netbiosName: z.string().regex(/^[A-Za-z0-9-]{0,15}$/).optional(),
    workgroup: z.string().regex(/^[A-Za-z0-9-]{0,15}$/).optional(),
    minProtocol: z.enum(["SMB2", "SMB3"]).optional(),
    encryption: z.enum(["off", "desired", "required"]).optional(),
    discoveryWsd: z.boolean().optional(),
    discoveryMdns: z.boolean().optional(),
    autoBlock: z.boolean().optional(),
    blockThreshold: z.number().int().min(1).max(100).optional(),
    blockWindowMin: z.number().int().min(1).max(1440).optional(),
    blockForMin: z.number().int().min(1).max(10080).optional(),
  }),
} satisfies Record<ShareOp, z.ZodTypeAny>

function parseInput<T extends ShareOp>(op: T, input: unknown): z.infer<typeof zShareInputs[T]> {
  const r = zShareInputs[op].safeParse(input)
  if (!r.success) throw new TRPCError({ code: "BAD_REQUEST", message: r.error.issues[0]?.message ?? "Invalid input" })
  return r.data as z.infer<typeof zShareInputs[T]>
}

// Today's checks for a share change, the change as a plan sees it, and the
// database write that follows a successful plan.
async function prepare(ctx: Context, op: ShareOp, raw: unknown): Promise<{ name: string; change: ShareChange; commit: () => Promise<unknown> }> {
  const prisma = ctx.prisma
  if (op === "share.create") {
    const input = parseInput(op, raw)
    const place = await prisma.place.findUnique({ where: { id: input.placeId } })
    if (!place) throw new TRPCError({ code: "NOT_FOUND", message: "Place not found" })
    if (await prisma.share.findUnique({ where: { placeId: input.placeId } }))
      throw new TRPCError({ code: "CONFLICT", message: "This place is already shared" })
    const name = effectiveSmbName({ smbName: input.smbName ?? null }, place.name)
    await assertUniqueName(prisma, name)
    const data = { placeId: input.placeId, smbName: input.smbName ?? null, readOnly: input.readOnly, guestOk: input.guestOk, hidden: input.hidden }
    return {
      name,
      change: { kind: "create", row: { id: "(new)", ...data, enabled: true, place: { name: place.name, path: place.path } } },
      commit: () => prisma.share.create({ data }),
    }
  }
  if (op === "smb.settings") {
    const patch = parseInput(op, raw)
    return {
      name: "SMB",
      change: { kind: "settings", patch },
      commit: async () => {
        await getSmbSettings(prisma)
        const s = await prisma.smbSettings.update({ where: { id: 1 }, data: patch })
        // Announcements follow the stored settings; a missing tool is shown
        // in the settings, not raised as a failed save.
        // Only what changed: a wsdd the admin runs is left alone by a rename.
        const wsd = patch.discoveryWsd
        const mdns = patch.discoveryMdns ?? (patch.netbiosName !== undefined && s.discoveryMdns ? true : undefined)
        if (wsd !== undefined || mdns !== undefined) {
          await requestSync("root.sharing.discovery", { wsd, mdns, name: s.netbiosName }).catch(() => {})
        }
      },
    }
  }
  const input = parseInput(op, raw)
  const share = await prisma.share.findUnique({ where: { id: input.id }, include: { place: { select: { name: true } } } })
  if (!share) throw new TRPCError({ code: "NOT_FOUND", message: "Share not found" })
  if (op === "share.remove") {
    return {
      name: effectiveSmbName(share, share.place.name),
      change: { kind: "remove", id: share.id },
      commit: () => prisma.share.delete({ where: { id: share.id } }),
    }
  }
  const u = input as z.infer<typeof zShareInputs["share.update"]>
  const patch = {
    ...(u.enabled !== undefined && { enabled: u.enabled }),
    ...(u.readOnly !== undefined && { readOnly: u.readOnly }),
    ...(u.guestOk !== undefined && { guestOk: u.guestOk }),
    ...(u.hidden !== undefined && { hidden: u.hidden }),
    ...(u.smbName !== undefined && { smbName: u.smbName }),
  }
  const name = effectiveSmbName({ smbName: u.smbName !== undefined ? u.smbName : share.smbName }, share.place.name)
  if (u.smbName !== undefined) await assertUniqueName(prisma, name, share.id)
  return {
    name,
    change: { kind: "update", id: share.id, patch },
    commit: () => prisma.share.update({ where: { id: share.id }, data: patch }),
  }
}

function planDeps(ctx: Context, change: ShareChange, commit: () => Promise<unknown>, timeout: number): SharePlanDeps {
  return {
    smbdInstalled: () => requestSync<{ smbdInstalled: boolean }>("root.sharing.checkPrereqs", {}).then(r => r.smbdInstalled),
    defs:   () => desiredShareDefs(ctx.prisma, change),
    smbSettings: () => currentSmbSettings(ctx.prisma, change.kind === "settings" ? change.patch : undefined),
    worker: <T>(subject: string, payload: Record<string, unknown>) => requestSync<T>(subject, payload, timeout),
    commit,
    serialize: withShareLock,
    resync: () => syncShares(ctx.prisma),
  }
}

export const sharingRouter = router({
  // Operation plans (#36): preview the smb.conf change and smbd reload of a
  // share change, then apply exactly that plan.
  plan: adminProcedure
    .input(z.object({ op: z.enum(SHARE_OPS), input: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const { name, change, commit } = await prepare(ctx, input.op, input.input)
      ctx.audit.target = name
      return previewShareChange(input.op, name, planDeps(ctx, change, commit, 60_000))
    }),

  execute: adminProcedure
    .input(z.object({ op: z.enum(SHARE_OPS), input: z.unknown(), fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { name, change, commit } = await prepare(ctx, input.op, input.input)
      ctx.audit.target = name
      const res = await applyShareChange(input.op, name, input.fingerprint, planDeps(ctx, change, commit, 180_000))
      ctx.audit.meta = { plan: planAuditMeta(input.op, res.steps, res.results) }
      ctx.audit.success = res.ok
      return res
    }),

  list: adminProcedure.query(async ({ ctx }) => {
    const shares = await ctx.prisma.share.findMany({
      include: { place: { select: { id: true, name: true, path: true } } },
      orderBy: { createdAt: "asc" },
    })
    const [sessions, facts, adminLinux] = await Promise.all([
      sessionsNow(), sambaFacts([...new Set(shares.map(s => s.place.path))]), adminLinuxUsers(ctx.prisma),
    ])
    return Promise.all(
      shares.map(async (s) => {
        const users = await resolveShareUsers(ctx.prisma, s.placeId)
        const name = effectiveSmbName(s, s.place.name)
        const dir = facts.dirs.get(s.place.path)
        const noPassword = [...new Set([...users.validUsers, ...adminLinux])].some(u => !facts.sambaUsers.has(u))
        return {
          id: s.id,
          hidden: s.hidden,
          connected: peopleConnected(sessions.filter(c => c.share === name)),
          problem: s.enabled && (users.excludedUsernames.length > 0 || (facts.sambaUsers.size > 0 && noPassword) || (dir !== undefined && !(dir.exists && dir.groupWritable && dir.setgid))),
          placeId: s.placeId,
          placeName: s.place.name,
          placePath: s.place.path,
          enabled: s.enabled,
          readOnly: s.readOnly,
          guestOk: s.guestOk,
          smbName: s.smbName,
          effectiveName: effectiveSmbName(s, s.place.name),
          userCount: users.validUsers.length,
          excludedUsernames: users.excludedUsernames,
        }
      }),
    )
  }),

  // Sharing app: service state and settings (admin).
  service: adminProcedure.query(async ({ ctx }) => {
    const [state, settings, sessions] = await Promise.all([
      smbServiceState().catch(() => null), getSmbSettings(ctx.prisma), sessionsNow(),
    ])
    const { eventCursor: _cursor, ...shown } = settings
    return { state, settings: shown, connectedCount: peopleConnected(sessions) }
  }),

  serviceAction: adminProcedure
    .input(z.object({ action: z.enum(["start", "restart"]) }))
    .mutation(async ({ ctx, input }) => {
      ctx.audit.target = `smbd ${input.action}`
      await requestSync("root.sharing.serviceAction", { action: input.action }, 60_000)
      return { ok: true }
    }),

  detail: adminProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const s = await ctx.prisma.share.findUnique({ where: { id: input.id }, include: { place: { select: { name: true, path: true } } } })
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Share not found" })
    const name = effectiveSmbName(s, s.place.name)
    const [users, adminLinux, facts, sessions, viewer] = await Promise.all([
      resolveShareUsers(ctx.prisma, s.placeId), adminLinuxUsers(ctx.prisma), sambaFacts([s.place.path]), sessionsNow(),
      viewerOf(ctx.prisma, ctx.user.userId),
    ])
    const access = users.entries
      .filter(e => shareExclusionReason(e.linuxUsername) === null)
      .map(e => ({ username: e.username, linuxUsername: e.linuxUsername!, level: (e.write && !s.readOnly ? "write" : "read") as "read" | "write", via: e.via as "user" | "group" | "admin" }))
    for (const a of adminLinux) {
      if (!access.some(x => x.linuxUsername === a)) access.push({ username: a, linuxUsername: a, level: s.readOnly ? "read" : "write", via: "admin" })
    }
    access.sort((a, b) => a.username.localeCompare(b.username))
    const dir = facts.dirs.get(s.place.path) ?? null
    const recent = await listEvents(ctx.prisma, viewer, { share: name, limit: 40 })
    return {
      share: {
        id: s.id, name, placeName: s.place.name, placePath: s.place.path, enabled: s.enabled,
        readOnly: s.readOnly, guestOk: s.guestOk, hidden: s.hidden, smbName: s.smbName,
      },
      access: access.map(a => ({ ...a, networkPassword: facts.sambaUsers.has(a.linuxUsername) })),
      sessions: sessions.filter(c => c.share === name),
      checks: {
        dirOk: dir === null ? null : dir.exists && dir.groupWritable && dir.setgid,
        dirExists: dir?.exists ?? null,
        nobodyCanWrite: !s.readOnly && access.every(a => a.level === "read"),
        excluded: users.entries
          .map(e => ({ username: e.username, reason: shareExclusionReason(e.linuxUsername) }))
          .filter((e): e is { username: string; reason: string } => e.reason !== null),
      },
      recent: recent.items,
    }
  }),

  // Every process serving one session line; one already gone is fine.
  disconnect: adminProcedure
    .input(z.object({ pids: z.array(z.string().regex(/^[0-9]+$/)).min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const pids = [...new Set(input.pids)]
      ctx.audit.target = `pid ${pids.join(", ")}`
      let ended = 0
      for (const pid of pids) {
        try {
          await requestSync("root.sharing.disconnect", { pid })
          ended++
        } catch (e) {
          if ((e as { code?: string }).code !== "NOT_A_SESSION") throw e
        }
      }
      if (ended === 0) throw new TRPCError({ code: "NOT_FOUND", message: "This session has already ended" })
      return { ok: true }
    }),

  blocks: adminProcedure.query(({ ctx }) => listBlocks(ctx.prisma, callerIp(ctx))),

  unblock: adminProcedure
    .input(z.object({ ip: z.string().max(64).refine(v => isIP(v) !== 0, "Not an address") }))
    .mutation(async ({ ctx, input }) => {
      ctx.audit.target = input.ip
      await liftBlock(ctx.prisma, input.ip)
      await syncShares(ctx.prisma)
      return { ok: true }
    }),

  // Any signed-in user: filtered to what concerns them.
  sessions: protectedProcedure.query(async ({ ctx }) =>
    visibleSessions(await sessionsNow(), await viewerOf(ctx.prisma, ctx.user.userId))),

  events: protectedProcedure
    .input(z.object({
      share: z.string().max(64).optional(),
      user: z.string().max(64).optional(),
      result: z.enum(["ok", "refused"]).optional(),
      sinceMs: z.number().int().nonnegative().optional(),
      cursor: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ ctx, input }) => listEvents(ctx.prisma, await viewerOf(ctx.prisma, ctx.user.userId), {
      share: input.share, user: input.user, result: input.result, cursor: input.cursor, limit: input.limit,
      since: input.sinceMs !== undefined ? new Date(input.sinceMs) : undefined,
    })),

  mine: protectedProcedure.query(async ({ ctx }) => {
    const viewer = await viewerOf(ctx.prisma, ctx.user.userId)
    const [shares, settings, facts, state] = await Promise.all([
      reachableShares(ctx.prisma, viewer), getSmbSettings(ctx.prisma), sambaFacts([]), smbServiceState().catch(() => null),
    ])
    return {
      username: viewer.username,
      shares,
      networkPassword: facts.sambaUsers.has(viewer.username),
      serviceActive: state?.active ?? false,
      netbiosName: settings.netbiosName,
      discovery: { wsd: settings.discoveryWsd && !!state?.wsddOn, mdns: settings.discoveryMdns && !!state?.avahiOn },
    }
  }),

  repairPassword: protectedProcedure
    .input(z.object({ password: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => repairNetworkPassword(
      ctx.prisma, await viewerOf(ctx.prisma, ctx.user.userId), input.password, callerIp(ctx),
      { verify: verifyPassword, sync: syncSystemPassword },
    )),
})
