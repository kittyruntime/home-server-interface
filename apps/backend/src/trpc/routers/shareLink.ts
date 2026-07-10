import { z } from "zod"
import crypto from "node:crypto"
import { basename, normalize } from "node:path"
import bcrypt from "bcryptjs"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, publicProcedure } from "../index"
import { checkPathPerm } from "./fs"           // see Step 2 — must be exported
import { verifyShareToken, signShareToken } from "../auth"
import { requestSync } from "../../nats"

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

export type LoadedLink = {
  id: string; path: string; isDir: boolean; passwordHash: string | null
  maxDownloads: number | null; downloads: number
  creatorId: string; linuxUser: string
  // Worker containment root for root.fs.* calls: always the shared path itself,
  // for every creator (including admins) — nothing outside it is reachable.
  allowedRoot: string
}

// Returns the link + resolved creator context, or a typed failure. Does NOT
// check the password (callers decide when a token is required).
export async function loadLink(prisma: any, token: string):
  Promise<{ ok: true; link: LoadedLink } | { ok: false; reason: "notfound" | "disabled" | "expired" | "exhausted" | "creator" }> {
  const row = await prisma.shareLink.findUnique({ where: { token } })
  if (!row) return { ok: false, reason: "notfound" }
  const state = resolveShareState(row)
  if (!state.ok) return { ok: false, reason: state.reason! }

  // Creator must still have canRead on the shared path (fail-closed).
  const creator = await prisma.user.findUnique({
    where: { id: row.creatorId }, select: { linuxUsername: true },
  })
  if (!creator) return { ok: false, reason: "creator" }
  // Authorization only — does not determine the worker containment root.
  const authRoot = await creatorAllowedRoot(prisma, row.creatorId, row.path)
  if (authRoot === undefined) return { ok: false, reason: "creator" }

  return {
    ok: true,
    link: {
      id: row.id, path: row.path, isDir: row.isDir, passwordHash: row.passwordHash,
      maxDownloads: row.maxDownloads, downloads: row.downloads,
      creatorId: row.creatorId, linuxUser: creator.linuxUsername ?? "",
      // Containment root is always the shared path itself, never the admin
      // "no root" sentinel — the worker must not allow escaping this dir.
      allowedRoot: row.path,
    },
  }
}

// Mirrors routes/files.ts resolveAllowedRoot but for canRead only, admin-aware.
async function creatorAllowedRoot(prisma: any, userId: string, path: string): Promise<string | null | undefined> {
  const roles = await prisma.userRole.findMany({ where: { userId }, select: { roleId: true, role: { select: { isAdmin: true } } } })
  if (roles.some((r: any) => r.role.isAdmin)) return null
  const places = await prisma.place.findMany()
  const place = places.find((p: any) => path === p.path || path.startsWith(p.path + "/"))
  if (!place) return undefined
  const roleIds = roles.map((r: any) => r.roleId)
  const [u, r] = await Promise.all([
    prisma.userPlacePermission.findFirst({ where: { userId, placeId: place.id, canRead: true } }),
    roleIds.length ? prisma.rolePlacePermission.findFirst({ where: { roleId: { in: roleIds }, placeId: place.id, canRead: true } }) : null,
  ])
  return (u || r) ? place.path : undefined
}

// Validates a requested relative subPath stays within the shared dir root.
export function resolveSubPath(link: LoadedLink, subPath: string): string | null {
  const clean = normalize(subPath || "").replace(/^(\.\.(\/|\\|$))+/, "")
  const abs = normalize(link.path + "/" + clean)
  if (abs !== link.path && !abs.startsWith(link.path + "/")) return null
  return abs
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

  // ── Public endpoints (unauthenticated) ────────────────────────────────────

  info: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ ctx, input }) => {
      const res = await loadLink(ctx.prisma, input.token)
      if (!res.ok) return { needsPassword: false, state: res.reason === "creator" ? "notfound" as const : res.reason }
      const { link } = res
      if (link.passwordHash) return { needsPassword: true, state: "ok" as const }
      return {
        needsPassword: false, state: "ok" as const,
        kind: link.isDir ? "dir" as const : "file" as const,
        name: basename(link.path),
        ...(link.isDir ? {} : { size: await statSize(link) }),
      }
    }),

  unlock: publicProcedure
    .input(z.object({ token: z.string(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const res = await loadLink(ctx.prisma, input.token)
      if (!res.ok) throw new TRPCError({ code: "NOT_FOUND", message: "Link unavailable" })
      if (!res.link.passwordHash) return { accessToken: signShareToken(res.link.id) }
      const ok = await bcrypt.compare(input.password, res.link.passwordHash)
      if (!ok) throw new TRPCError({ code: "UNAUTHORIZED", message: "Wrong password" })
      return { accessToken: signShareToken(res.link.id) }
    }),

  browse: publicProcedure
    .input(z.object({ token: z.string(), subPath: z.string().default(""), accessToken: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const res = await loadLink(ctx.prisma, input.token)
      if (!res.ok || !res.link.isDir) throw new TRPCError({ code: "NOT_FOUND", message: "Not a folder" })
      requireAccess(res.link, input.accessToken)
      const abs = resolveSubPath(res.link, input.subPath)
      if (!abs) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid path" })
      let entries: { name: string; type: "dir" | "file"; size: number | null }[]
      try {
        entries = await requestSync<{ name: string; type: "dir" | "file"; size: number | null }[]>(
          "root.fs.list",
          { path: abs, linuxUsername: res.link.linuxUser, allowedRoot: res.link.allowedRoot ?? "" },
        )
      } catch {
        throw new TRPCError({ code: "NOT_FOUND", message: "Not available" })
      }
      return { entries }
    }),
})

// Enforces the share access token on password-protected links.
function requireAccess(link: LoadedLink, accessToken?: string) {
  if (!link.passwordHash) return
  if (!accessToken) throw new TRPCError({ code: "UNAUTHORIZED", message: "Password required" })
  let payload: ReturnType<typeof verifyShareToken>
  try {
    payload = verifyShareToken(accessToken)
  } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid token" })
  }
  if (payload.shareLinkId !== link.id) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid token" })
}

async function statSize(link: LoadedLink): Promise<number | null> {
  try {
    const s = await requestSync<{ type: string; size: number | null }>(
      "root.fs.stat", { path: link.path, linuxUsername: link.linuxUser, allowedRoot: link.allowedRoot ?? "" },
    )
    return s.size
  } catch {
    throw new TRPCError({ code: "NOT_FOUND", message: "Not available" })
  }
}

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
