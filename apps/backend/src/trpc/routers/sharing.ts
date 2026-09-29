import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, adminProcedure } from "../index"
import { requestSync } from "../../nats"
import {
  resolveShareUsers,
  effectiveSmbName,
  adminLinuxUsers,
  shareExclusionReason,
  desiredShareDefs,
  syncShares,
  withShareLock,
} from "../../services/sharing.service"
import {
  SHARE_OPS, applyShareChange, previewShareChange,
  type ShareChange, type ShareOp, type SharePlanDeps,
} from "../../services/sharing-plan"
import { planAuditMeta } from "../../services/storage-plan"
import type { Context } from "../context"

type DirState = {
  path: string; exists: boolean; group: string; mode: string; setgid: boolean; groupWritable: boolean
}

const reSmbName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

type ShareConnection = { user: string; share: string; client: string; connectedAt: string }

function throwSyncError(e: unknown): never {
  if ((e as { code?: string })?.code === "SMBD_MISSING") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Samba is not installed on the host. Run: apt install samba",
    })
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: (e as Error)?.message ?? "Share sync failed",
  })
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
  }),
  "share.update": z.object({
    id: z.string(),
    enabled: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    guestOk: z.boolean().optional(),
    smbName: z.string().regex(reSmbName).nullable().optional(),
  }),
  "share.remove": z.object({ id: z.string() }),
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
    const data = { placeId: input.placeId, smbName: input.smbName ?? null, readOnly: input.readOnly, guestOk: input.guestOk }
    return {
      name,
      change: { kind: "create", row: { id: "(new)", ...data, enabled: true, place: { name: place.name, path: place.path } } },
      commit: () => prisma.share.create({ data }),
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

  apply: adminProcedure
    .input(z.object({ op: z.enum(SHARE_OPS), input: z.unknown(), fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { name, change, commit } = await prepare(ctx, input.op, input.input)
      ctx.audit.target = name
      const res = await applyShareChange(input.op, name, input.fingerprint, planDeps(ctx, change, commit, 180_000))
      ctx.audit.meta = { plan: planAuditMeta(input.op, res.steps, res.results) }
      ctx.audit.success = res.ok
      return res
    }),

  checkPrereqs: adminProcedure.query(() =>
    requestSync<{ smbdInstalled: boolean }>("root.sharing.checkPrereqs", {}),
  ),

  list: adminProcedure.query(async ({ ctx }) => {
    const shares = await ctx.prisma.share.findMany({
      include: { place: { select: { id: true, name: true, path: true } } },
      orderBy: { createdAt: "asc" },
    })
    return Promise.all(
      shares.map(async (s) => {
        const users = await resolveShareUsers(ctx.prisma, s.placeId)
        return {
          id: s.id,
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

  create: adminProcedure
    .input(
      z.object({
        placeId: z.string(),
        smbName: z.string().regex(reSmbName).optional(),
        readOnly: z.boolean().default(false),
        guestOk: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const place = await ctx.prisma.place.findUnique({ where: { id: input.placeId } })
      if (!place) throw new TRPCError({ code: "NOT_FOUND", message: "Place not found" })
      const existing = await ctx.prisma.share.findUnique({ where: { placeId: input.placeId } })
      if (existing)
        throw new TRPCError({ code: "CONFLICT", message: "This place is already shared" })
      const name = effectiveSmbName({ smbName: input.smbName ?? null }, place.name)
      await assertUniqueName(ctx.prisma, name)

      const share = await ctx.prisma.share.create({
        data: {
          placeId: input.placeId,
          smbName: input.smbName ?? null,
          readOnly: input.readOnly,
          guestOk: input.guestOk,
        },
      })
      try {
        await syncShares(ctx.prisma)
      } catch (e) {
        // Roll the row back so the UI never shows a share Samba doesn't have.
        await ctx.prisma.share.delete({ where: { id: share.id } }).catch(() => {})
        throwSyncError(e)
      }
      return share
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string(),
        enabled: z.boolean().optional(),
        readOnly: z.boolean().optional(),
        guestOk: z.boolean().optional(),
        smbName: z.string().regex(reSmbName).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const share = await ctx.prisma.share.findUnique({
        where: { id: input.id },
        include: { place: { select: { name: true } } },
      })
      if (!share) throw new TRPCError({ code: "NOT_FOUND", message: "Share not found" })
      if (input.smbName !== undefined) {
        const name = effectiveSmbName({ smbName: input.smbName }, share.place.name)
        await assertUniqueName(ctx.prisma, name, share.id)
      }
      const updated = await ctx.prisma.share.update({
        where: { id: input.id },
        data: {
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.readOnly !== undefined && { readOnly: input.readOnly }),
          ...(input.guestOk !== undefined && { guestOk: input.guestOk }),
          ...(input.smbName !== undefined && { smbName: input.smbName }),
        },
      })
      try {
        await syncShares(ctx.prisma)
      } catch (e) {
        throwSyncError(e)
      }
      return updated
    }),

  remove: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.share.delete({ where: { id: input.id } })
      try {
        await syncShares(ctx.prisma)
      } catch (e) {
        // Row is gone; if Samba is missing there is nothing to clean up.
        if ((e as { code?: string })?.code !== "SMBD_MISSING") throwSyncError(e)
      }
      return { ok: true }
    }),

  status: adminProcedure.query(async () => {
    try {
      return await requestSync<{ connections: ShareConnection[] }>("root.sharing.status", {})
    } catch (e) {
      if ((e as { code?: string })?.code === "SMBD_MISSING") return { connections: [] }
      throw e
    }
  }),

  // Per-share health: who can actually read/write (and whether they have a Samba
  // password), who's permitted but excluded (no Linux account / root) and why, and
  // the on-disk state of the share directory. Turns "it's broken" into a glance.
  diagnose: adminProcedure.query(async ({ ctx }) => {
    const shares = await ctx.prisma.share.findMany({
      where: { enabled: true },
      include: { place: { select: { name: true, path: true } } },
      orderBy: { createdAt: "asc" },
    })
    const adminLinux = await adminLinuxUsers(ctx.prisma)

    // Worker facts: which accounts have a Samba password + on-disk dir state.
    const paths = [...new Set(shares.map((s) => s.place.path))]
    let sambaUsers: string[] = []
    let dirs: DirState[] = []
    try {
      const diag = await requestSync<{ sambaUsers: string[]; dirs: DirState[] }>(
        "root.sharing.diag", { paths },
      )
      sambaUsers = diag.sambaUsers ?? []
      dirs = diag.dirs ?? []
    } catch { /* worker/samba unavailable — degrade gracefully */ }
    const sambaSet = new Set(sambaUsers)
    const dirByPath = new Map(dirs.map((d) => [d.path, d]))
    const withSamba = (linux: string) => ({ linuxUsername: linux, hasSamba: sambaSet.has(linux) })

    const result = await Promise.all(shares.map(async (s) => {
      const users = await resolveShareUsers(ctx.prisma, s.placeId)
      const writeSet = new Set([...users.writeUsers, ...adminLinux])
      const writers = [...writeSet].sort().map(withSamba)
      const readers = [...new Set(users.validUsers)].filter((l) => !writeSet.has(l)).sort().map(withSamba)
      const excluded = users.entries
        .map((e) => ({ username: e.username, reason: shareExclusionReason(e.linuxUsername) }))
        .filter((e): e is { username: string; reason: string } => e.reason !== null)
      return {
        id:       s.id,
        name:     effectiveSmbName(s, s.place.name),
        path:     s.place.path,
        readOnly: s.readOnly,
        guestOk:  s.guestOk,
        writers,   // effective write users (+ their Samba-account status)
        readers,   // read-only users
        excluded,  // permitted but can't use sharing, with the reason
        dir:      dirByPath.get(s.place.path) ?? null,
      }
    }))
    return { shares: result }
  }),
})
