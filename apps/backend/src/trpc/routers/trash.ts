import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure } from "../index"
import { checkPathPerm, getLinuxUser, mapWorkerError } from "./fs"
import { trashRequest, type TrashEntry } from "../../services/trash"

// The trash of the places that have one (#200). Who may delete in a place
// sees, restores and removes its trash; the worker acts as that user.

const zId = z.string().min(1).max(255).refine(id => !id.includes("/") && id !== "." && id !== "..", "Invalid item")

async function trashPlace(ctx: Parameters<typeof checkPathPerm>[0], placeId: string) {
  const place = await ctx.prisma.place.findUnique({ where: { id: placeId } })
  if (!place) throw new TRPCError({ code: "NOT_FOUND", message: "Place not found" })
  if (!place.trashEnabled) throw new TRPCError({ code: "BAD_REQUEST", message: "This place has no trash" })
  await checkPathPerm(ctx, place.path, "canDelete")
  return place as { id: string; name: string; path: string }
}

export const trashRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const places = await ctx.prisma.place.findMany({ where: { trashEnabled: true }, orderBy: { createdAt: "asc" } })
    const linuxUser = await getLinuxUser(ctx)
    const out: { placeId: string; placeName: string; placePath: string; entries: TrashEntry[]; error?: string }[] = []
    for (const place of places as { id: string; name: string; path: string }[]) {
      try { await checkPathPerm(ctx, place.path, "canDelete") } catch { continue }
      try {
        const entries = await trashRequest<TrashEntry[]>({ op: "list", placeRoot: place.path, linuxUsername: linuxUser ?? "" })
        out.push({ placeId: place.id, placeName: place.name, placePath: place.path, entries })
      } catch (e) {
        out.push({ placeId: place.id, placeName: place.name, placePath: place.path, entries: [], error: (e as Error).message })
      }
    }
    return out
  }),

  restore: protectedProcedure
    .input(z.object({ placeId: z.string(), id: zId, target: z.string().max(4096).optional() }))
    .mutation(async ({ ctx, input }) => {
      const place = await trashPlace(ctx, input.placeId)
      ctx.audit.target = `${place.name}: ${input.id}`
      // Restoring writes in the place: the worker keeps the item inside it,
      // whatever path its info file names.
      await checkPathPerm(ctx, input.target ?? place.path, "canWrite")
      if (input.target) await checkPathPerm(ctx, place.path, "canWrite")
      try {
        return await trashRequest<{ path: string }>({
          op: "restore", placeRoot: place.path, ids: [input.id], target: input.target ?? "",
          linuxUsername: (await getLinuxUser(ctx)) ?? "",
        })
      } catch (e) { throw mapWorkerError(e) }
    }),

  delete: protectedProcedure
    .input(z.object({ placeId: z.string(), ids: z.array(zId).min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const place = await trashPlace(ctx, input.placeId)
      ctx.audit.target = `${place.name}: ${input.ids.length} item(s)`
      try {
        return await trashRequest<{ ok: boolean }>({
          op: "delete", placeRoot: place.path, ids: input.ids, linuxUsername: (await getLinuxUser(ctx)) ?? "",
        }, 300_000)
      } catch (e) { throw mapWorkerError(e) }
    }),

  empty: protectedProcedure
    .input(z.object({ placeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const place = await trashPlace(ctx, input.placeId)
      ctx.audit.target = place.name
      try {
        return await trashRequest<{ ok: boolean }>({
          op: "empty", placeRoot: place.path, linuxUsername: (await getLinuxUser(ctx)) ?? "",
        }, 300_000)
      } catch (e) { throw mapWorkerError(e) }
    }),
})
