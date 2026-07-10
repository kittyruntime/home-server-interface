import { z } from "zod"
import crypto from "node:crypto"
import { normalize } from "node:path"
import bcrypt from "bcryptjs"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure } from "../index"
import { checkPathPerm } from "./fs"           // see Step 2 — must be exported

// URL-safe random slug, ~22 chars, independent of the row uuid.
export function randomToken(): string {
  return crypto.randomBytes(16).toString("base64url")
}

type LinkState = { ok: boolean; reason?: "disabled" | "expired" | "exhausted" }
export function resolveShareState(link: {
  disabled: boolean; expiresAt: Date | null; maxDownloads: number | null; downloads: number
}): LinkState {
  if (link.disabled) return { ok: false, reason: "disabled" }
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" }
  if (link.maxDownloads != null && link.downloads >= link.maxDownloads) return { ok: false, reason: "exhausted" }
  return { ok: true }
}

export const shareLinkRouter = router({
  create: protectedProcedure
    .input(z.object({
      path: z.string(),
      password: z.string().min(1).max(200).optional(),
      expiresInDays: z.number().int().positive().max(3650).optional(),
      maxDownloads: z.number().int().positive().max(1_000_000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const p = normalize(input.path)

      // Authorize: caller must have canShare on the place containing `path`.
      const allowedRoot = await checkPathPerm(ctx, p, "canShare")

      // Determine file vs dir via the privileged stat (same channel fs uses).
      const linuxUser = await ctx.prisma.user
        .findUnique({ where: { id: ctx.user.userId }, select: { linuxUsername: true } })
        .then((u: { linuxUsername: string | null } | null) => u?.linuxUsername ?? "")
      let isDir: boolean
      try {
        const s = await requestStat(p, linuxUser, allowedRoot ?? "")
        isDir = s.type === "dir"
      } catch {
        throw new TRPCError({ code: "NOT_FOUND", message: "Path not found" })
      }

      const token = randomToken()
      const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : null
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null

      await ctx.prisma.shareLink.create({
        data: {
          token, path: p, isDir,
          creatorId: ctx.user.userId,
          passwordHash, expiresAt,
          maxDownloads: input.maxDownloads ?? null,
        },
      })
      return { token }
    }),

  listMine: protectedProcedure.query(async ({ ctx }) => {
    const links = await ctx.prisma.shareLink.findMany({
      where: ctx.user.isAdmin ? {} : { creatorId: ctx.user.userId },
      orderBy: { createdAt: "desc" },
    })
    return links.map((l: any) => ({
      id: l.id, token: l.token, path: l.path, isDir: l.isDir,
      hasPassword: l.passwordHash != null,
      expiresAt: l.expiresAt, maxDownloads: l.maxDownloads,
      downloads: l.downloads, disabled: l.disabled,
      createdAt: l.createdAt, lastAccessAt: l.lastAccessAt,
    }))
  }),

  revoke: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnerOrAdmin(ctx, input.id)
      await ctx.prisma.shareLink.update({ where: { id: input.id }, data: { disabled: true } })
      return { ok: true as const }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnerOrAdmin(ctx, input.id)
      await ctx.prisma.shareLink.delete({ where: { id: input.id } })
      return { ok: true as const }
    }),
})

async function assertOwnerOrAdmin(ctx: any, id: string) {
  const link = await ctx.prisma.shareLink.findUnique({ where: { id }, select: { creatorId: true } })
  if (!link) throw new TRPCError({ code: "NOT_FOUND", message: "Link not found" })
  if (!ctx.user.isAdmin && link.creatorId !== ctx.user.userId)
    throw new TRPCError({ code: "FORBIDDEN", message: "Not your link" })
}

// Privileged stat helper (mirrors fs.ts readText's stat call).
async function requestStat(path: string, linuxUsername: string, allowedRoot: string): Promise<{ type: string; size: number | null }> {
  const { requestSync } = await import("../../nats")
  return requestSync<{ type: string; size: number | null }>(
    "root.fs.stat",
    { path, linuxUsername, allowedRoot },
  )
}
