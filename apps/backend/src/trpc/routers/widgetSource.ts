import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"
import {
  ALERT_SOURCE, WIDGET_COMMANDS, hashToken, headersToStore, lastValueOf, newPushToken, readSource, sameOrigin,
  refreshSource, sourceView, storedHeaders, zSourceInput,
} from "../../services/widget-sources"

const id = z.string().uuid()

/** Up to `max` points, evenly picked, the last one kept. */
function thin<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list
  const step = list.length / max
  const out = Array.from({ length: max - 1 }, (_, i) => list[Math.floor(i * step)]!)
  out.push(list[list.length - 1]!)
  return out
}

export const widgetSourceRouter = router({
  // Admins see every source with its settings; others, the ones shared with
  // everyone, by name only.
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.prisma.widgetSource.findMany({ orderBy: { name: "asc" } })
    if (ctx.user.isAdmin) return rows.map(r => ({ ...sourceView(r), editable: true as const }))
    return rows.filter(r => r.visibility === "everyone").map(r => ({ id: r.id, name: r.name, kind: r.kind, editable: false as const }))
  }),

  commands: adminProcedure.query(() => [...WIDGET_COMMANDS]),

  create: adminProcedure.input(zSourceInput).mutation(async ({ ctx, input }) => {
    const token = input.kind === "push" ? newPushToken() : null
    const row = await ctx.prisma.widgetSource.create({
      data: {
        name: input.name, kind: input.kind, url: input.kind === "http" ? input.url : "", command: input.kind === "command" ? input.command : "",
        headers: JSON.stringify(input.kind === "http" ? headersToStore(input.headers, []) : []),
        intervalSec: input.intervalSec, visibility: input.visibility, trackPath: input.trackPath,
        alert: input.alert ? JSON.stringify(input.alert) : "", pushHash: token ? hashToken(token) : null,
        allowSelfSigned: input.kind === "http" && input.allowSelfSigned,
      },
    })
    if (row.kind !== "push") void refreshSource(row.id)
    // The token is shown this once.
    return { source: sourceView(row), token }
  }),

  update: adminProcedure.input(z.object({ id, source: zSourceInput })).mutation(async ({ ctx, input }) => {
    const prev = await ctx.prisma.widgetSource.findUnique({ where: { id: input.id } })
    if (!prev) throw new TRPCError({ code: "NOT_FOUND", message: "This source no longer exists" })
    const s = input.source
    const token = s.kind === "push" && !prev.pushHash ? newPushToken() : null
    const row = await ctx.prisma.widgetSource.update({
      where: { id: input.id },
      data: {
        name: s.name, kind: s.kind, url: s.kind === "http" ? s.url : "", command: s.kind === "command" ? s.command : "",
        headers: JSON.stringify(s.kind === "http" ? headersToStore(s.headers, sameOrigin(prev.url, s.url) ? storedHeaders(prev.headers) : []) : []),
        intervalSec: s.intervalSec, visibility: s.visibility, trackPath: s.trackPath,
        allowSelfSigned: s.kind === "http" && s.allowSelfSigned,
        alert: s.alert ? JSON.stringify(s.alert) : "",
        ...(token && { pushHash: hashToken(token) }),
        ...(s.kind !== "push" && { pushHash: null }),
        ...(s.trackPath !== prev.trackPath && { lastAt: null }),
      },
    })
    if (s.trackPath !== prev.trackPath) await ctx.prisma.widgetSourceSample.deleteMany({ where: { sourceId: row.id } })
    if (!s.alert) await ctx.prisma.alert.deleteMany({ where: { source: ALERT_SOURCE, target: row.id } })
    if (row.kind !== "push") void refreshSource(row.id)
    return { source: sourceView(row), token }
  }),

  remove: adminProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    await ctx.prisma.widgetSourceSample.deleteMany({ where: { sourceId: input.id } })
    await ctx.prisma.alert.deleteMany({ where: { source: ALERT_SOURCE, target: input.id } })
    await ctx.prisma.widgetSource.deleteMany({ where: { id: input.id } })
    return { ok: true }
  }),

  rotateToken: adminProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const token = newPushToken()
    const n = await ctx.prisma.widgetSource.updateMany({ where: { id: input.id, kind: "push" }, data: { pushHash: hashToken(token) } })
    if (!n.count) throw new TRPCError({ code: "NOT_FOUND", message: "No such push source" })
    return { token }
  }),

  // Reads the source as configured in the form, without saving it: secret
  // headers left empty use the stored ones of `id`.
  test: adminProcedure.input(z.object({ id: id.optional(), source: zSourceInput })).mutation(async ({ ctx, input }) => {
    const s = input.source
    if (s.kind === "push") {
      const row = input.id ? await ctx.prisma.widgetSource.findUnique({ where: { id: input.id } }) : null
      return { ok: true as const, value: row ? lastValueOf(row) ?? null : null }
    }
    const prev = input.id ? await ctx.prisma.widgetSource.findUnique({ where: { id: input.id } }) : null
    try {
      const kept = prev && sameOrigin(prev.url, s.url) ? storedHeaders(prev.headers) : []
      const value = await readSource({ kind: s.kind, url: s.url, command: s.command, allowSelfSigned: s.allowSelfSigned, headers: JSON.stringify(headersToStore(s.headers, kept)) })
      return { ok: true as const, value }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  }),

  refresh: adminProcedure.input(z.object({ id })).mutation(async ({ input }) => {
    await refreshSource(input.id)
    return { ok: true }
  }),

  // The last value of each source the viewer may read, and its history.
  data: protectedProcedure.input(z.object({ ids: z.array(id).max(24), history: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      // A wall display reads only the sources of its own widgets.
      const ids = ctx.wall ? input.ids.filter(i => ctx.wall!.sourceIds.has(i)) : input.ids
      const rows = await ctx.prisma.widgetSource.findMany({ where: { id: { in: ids } } })
      const visible = rows.filter(r => ctx.user.isAdmin || r.visibility === "everyone")
      const since = new Date(Date.now() - 86_400_000)
      return Promise.all(visible.map(async r => ({
        id: r.id, name: r.name,
        value: lastValueOf(r) ?? null,
        at: r.lastAt, error: r.lastError,
        history: input.history && r.trackPath
          ? thin(await ctx.prisma.widgetSourceSample.findMany({ where: { sourceId: r.id, timestamp: { gte: since } }, orderBy: { timestamp: "asc" } }), 240)
            .map(p => ({ t: p.timestamp.getTime(), v: p.value }))
          : [],
      })))
    }),
})
