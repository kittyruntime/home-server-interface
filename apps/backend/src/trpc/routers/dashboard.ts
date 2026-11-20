import { z } from "zod"
import { router, protectedProcedure, adminProcedure, storageProcedure } from "../index"
import { boardView, replaceBoards, zBoardsInput } from "../../services/dashboard-boards"
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
    .query(({ input }) => checkUrls([...new Set(input.urls)].filter(u => checkableUrl(u) != null))),

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
})
