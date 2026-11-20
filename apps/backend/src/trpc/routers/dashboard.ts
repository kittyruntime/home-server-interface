import { z } from "zod"
import { router, protectedProcedure, adminProcedure, storageProcedure } from "../index"
import { boardView, parseWidgets, replaceBoards, zBoardInput, zBoardsInput } from "../../services/dashboard-boards"
import { MAX_WALLS, newWallToken } from "../../services/dashboard-walls"
import { readSensors } from "../../services/hw-sensors"
import { readUps, type UpsReading } from "../../services/ups"
import { checkUrls, checkableUrl } from "../../services/link-status"
import { volumeForecasts } from "../../services/volume-usage"
import { cachedDigest, DigestUnavailable, writeDigest } from "../../services/dashboard-digest"
import { TRPCError } from "@trpc/server"

let sensorsCache: { at: number; value: ReturnType<typeof readSensors> } | null = null
let upsCache: { at: number; value: UpsReading[] | null } | null = null

export const dashboardRouter = router({
  // The viewer's boards; without any, the published set, then nothing (the
  // dashboard then shows its built-in default).
  boards: protectedProcedure.query(async ({ ctx }) => {
    const own = await ctx.prisma.dashboardBoard.findMany({ where: { ownerId: ctx.user.userId }, orderBy: { position: "asc" } })
    if (own.length) return { source: "own" as const, boards: own.map(boardView) }
    const published = await ctx.prisma.dashboardBoard.findMany({ where: { ownerId: null }, orderBy: { position: "asc" } })
    return { source: published.length ? "published" as const : "default" as const, boards: published.map(boardView) }
  }),

  save: protectedProcedure.input(zBoardsInput)
    .mutation(({ ctx, input }) => replaceBoards(ctx.prisma, ctx.user.userId, input.boards)),

  // Back to the published set (or the built-in default).
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.prisma.dashboardBoard.deleteMany({ where: { ownerId: ctx.user.userId } })
    return { ok: true }
  }),

  published: adminProcedure.query(async ({ ctx }) =>
    (await ctx.prisma.dashboardBoard.findMany({ where: { ownerId: null }, orderBy: { position: "asc" } })).map(boardView)),

  // What accounts without boards of their own start from. Accounts that already
  // have their own keep them.
  publish: adminProcedure.input(zBoardsInput)
    .mutation(({ ctx, input }) => replaceBoards(ctx.prisma, null, input.boards)),

  unpublish: adminProcedure.mutation(async ({ ctx }) => {
    await ctx.prisma.dashboardBoard.deleteMany({ where: { ownerId: null } })
    return { ok: true }
  }),

  sensors: protectedProcedure.query(() => {
    if (!sensorsCache || Date.now() - sensorsCache.at > 5_000) sensorsCache = { at: Date.now(), value: readSensors() }
    return sensorsCache.value
  }),

  // null: no Network UPS Tools server on this machine.
  ups: protectedProcedure.query(async () => {
    if (!upsCache || Date.now() - upsCache.at > 15_000) upsCache = { at: Date.now(), value: await readUps() }
    return upsCache.value
  }),

  forecast: storageProcedure.query(() => volumeForecasts()),

  // Admin only: the server reaches the address, which can be anywhere on the
  // local network.
  linkStatus: adminProcedure
    .input(z.object({ urls: z.array(z.string().max(2048)).max(24) }))
    .query(({ ctx, input }) => checkUrls([...new Set(input.urls)]
      // A wall display checks only the links saved on its widgets.
      .filter(u => checkableUrl(u) != null && (!ctx.wall || ctx.wall.linkUrls.has(u))))),

  // Today's summary by the assistant: admin only, since it reads every alert.
  digest: adminProcedure.input(z.object({ locale: z.enum(["en", "fr"]) }))
    .query(({ input }) => cachedDigest(input.locale)),

  writeDigest: adminProcedure.input(z.object({ locale: z.enum(["en", "fr"]) }))
    .mutation(async ({ ctx, input }) => {
      try { return await writeDigest({ userId: ctx.user.userId, isAdmin: true }, input.locale) }
      catch (e) {
        if (e instanceof DigestUnavailable) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message })
        throw new TRPCError({ code: "BAD_GATEWAY", message: e instanceof Error ? e.message : "The assistant did not answer" })
      }
    }),

  // ── Wall displays ──────────────────────────────────────────────────────────

  walls: protectedProcedure.query(async ({ ctx }) =>
    (await ctx.prisma.dashboardWall.findMany({ where: { ownerId: ctx.user.userId }, orderBy: { createdAt: "asc" } }))
      .map(w => ({ id: w.id, name: w.name, prefix: w.prefix, widgets: parseWidgets(w.widgets).length, lastSeenAt: w.lastSeenAt, createdAt: w.createdAt }))),

  // A display showing a copy of a board; its token is shown this once.
  createWall: protectedProcedure.input(zBoardInput).mutation(async ({ ctx, input }) => {
    if (await ctx.prisma.dashboardWall.count({ where: { ownerId: ctx.user.userId } }) >= MAX_WALLS) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `At most ${MAX_WALLS} wall displays per account` })
    }
    const { token, hash, prefix } = newWallToken()
    const wall = await ctx.prisma.dashboardWall.create({
      data: { ownerId: ctx.user.userId, name: input.name, widgets: JSON.stringify(input.widgets), tokenHash: hash, prefix },
    })
    return { id: wall.id, token }
  }),

  // Shows the board as it is now on an existing display, keeping its link.
  updateWall: protectedProcedure.input(zBoardInput.extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const n = await ctx.prisma.dashboardWall.updateMany({
        where: { id: input.id, ownerId: ctx.user.userId },
        data: { name: input.name, widgets: JSON.stringify(input.widgets) },
      })
      if (!n.count) throw new TRPCError({ code: "NOT_FOUND", message: "This display no longer exists" })
      return { ok: true }
    }),

  removeWall: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.prisma.dashboardWall.deleteMany({ where: { id: input.id, ownerId: ctx.user.userId } })
    return { ok: true }
  }),

  // What a display shows; only its own token reaches it.
  wall: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.wall) throw new TRPCError({ code: "FORBIDDEN", message: "Open this with a wall display link" })
    const w = await ctx.prisma.dashboardWall.findUnique({ where: { id: ctx.wall.id } })
    if (!w) throw new TRPCError({ code: "NOT_FOUND", message: "This display was removed" })
    return {
      name: w.name, widgets: parseWidgets(w.widgets),
      viewer: { isAdmin: ctx.user.isAdmin, storage: ctx.user.isAdmin || (ctx.user.capabilities ?? []).includes("storage") },
    }
  }),
})
