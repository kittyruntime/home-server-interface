import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure } from "../index"
import { CATALOG } from "@app/app-catalog"
import { listApps } from "../../services/container.service"

export const catalogRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    // "installed" if any managed app carries the hsi.catalog.id label.
    const apps = await listApps(ctx.prisma)
    const installedIds = new Set<string>()
    for (const a of apps) {
      const l = a.labels.find((x) => x.key === "hsi.catalog.id")
      if (l) installedIds.add(l.value)
    }
    return CATALOG.map((m) => ({ ...m, installed: installedIds.has(m.id) }))
  }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(({ input }) => {
    const m = CATALOG.find((x) => x.id === input.id)
    if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown app" })
    return m
  }),
})
