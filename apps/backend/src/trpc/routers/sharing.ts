import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, adminProcedure } from "../index"
import { requestSync } from "../../nats"
import {
  resolveShareUsers,
  effectiveSmbName,
  syncShares,
} from "../../services/sharing.service"

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

export const sharingRouter = router({
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
})
