import { z } from "zod"
import { readdir, stat } from "node:fs/promises"
import { join, normalize } from "node:path"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"
import { accessiblePlaceIds } from "./place"
import { publishJob, requestSync } from "../../nats"

// ── Shared helpers ────────────────────────────────────────────────────────────

async function getLinuxUser(ctx: { prisma: any; user: { userId: string } }): Promise<string | null> {
  const u = await ctx.prisma.user.findUnique({
    where:  { id: ctx.user.userId },
    select: { linuxUsername: true },
  })
  return u?.linuxUsername ?? null
}

async function checkPathPerm(
  ctx: { prisma: any; user: { userId: string; isAdmin: boolean } },
  path: string,
  flag: "canRead" | "canWrite" | "canDelete",
): Promise<void> {
  if (ctx.user.isAdmin) return

  const places = await ctx.prisma.place.findMany()
  const place  = places.find(
    (p: { path: string }) => path === p.path || path.startsWith(p.path + "/")
  )
  if (!place) throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" })

  const userRoles = await ctx.prisma.userRole.findMany({
    where: { userId: ctx.user.userId }, select: { roleId: true },
  })
  const roleIds = userRoles.map((r: { roleId: string }) => r.roleId)

  const [userPerm, rolePerm] = await Promise.all([
    ctx.prisma.userPlacePermission.findFirst({
      where: { userId: ctx.user.userId, placeId: place.id, [flag]: true },
    }),
    roleIds.length > 0
      ? ctx.prisma.rolePlacePermission.findFirst({
          where: { roleId: { in: roleIds }, placeId: place.id, [flag]: true },
        })
      : null,
  ])

  if (!userPerm && !rolePerm) throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" })
}

// Map worker error codes to tRPC errors.
function mapWorkerError(e: any): TRPCError {
  if (e instanceof TRPCError) return e
  switch (e?.code) {
    case "EACCES": return new TRPCError({ code: "FORBIDDEN",   message: "Permission denied" })
    case "ENOENT": return new TRPCError({ code: "NOT_FOUND",   message: "Not found" })
    case "EEXIST": return new TRPCError({ code: "CONFLICT",    message: "Destination already exists" })
    default:       return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e?.message ?? "Unknown error" })
  }
}

// ── list (sync, request-reply) ────────────────────────────────────────────────

type FsEntry = { name: string; path: string; type: "dir" | "file"; size: number | null; mtime: string }

async function listAsProcess(dirPath: string): Promise<FsEntry[]> {
  const names = await readdir(dirPath)
  const entries = await Promise.all(
    names.map(async (name) => {
      const fullPath = join(dirPath, name)
      try {
        const s = await stat(fullPath)
        return {
          name, path: fullPath,
          type: s.isDirectory() ? ("dir" as const) : ("file" as const),
          size: s.isFile() ? s.size : null,
          mtime: s.mtime.toISOString(),
        }
      } catch { return null }
    })
  )
  return entries.filter((e): e is FsEntry => e !== null)
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })
}

// ── Router ────────────────────────────────────────────────────────────────────

export const fsRouter = router({

  // ── list (sync) ─────────────────────────────────────────────────────────────
  list: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const p = normalize(input.path)
      if (!p.startsWith("/") || p.includes("\0")) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid path" })

      if (!ctx.user.isAdmin) {
        const ids    = await accessiblePlaceIds(ctx)
        const places = await ctx.prisma.place.findMany({ where: { id: { in: ids } } })
        const allowed = places.some((pl: { path: string }) => p === pl.path || p.startsWith(pl.path + "/"))
        if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" })
      }

      const linuxUser = await getLinuxUser(ctx)
      try {
        if (!linuxUser) {
          return sortEntries(await listAsProcess(p))
        }
        const entries = await requestSync<FsEntry[]>("brume.root.fs.list", { path: p, linuxUsername: linuxUser })
        return sortEntries(entries)
      } catch (e: any) {
        throw mapWorkerError(e)
      }
    }),

  // ── stat (sync) ──────────────────────────────────────────────────────────────
  stat: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const p = normalize(input.path)
      await checkPathPerm(ctx, p, "canRead")
      const linuxUser = await getLinuxUser(ctx)
      try {
        return await requestSync<{
          mode: string; owner: string; group: string; uid: number; gid: number; type: string; size: number | null
        }>("brume.root.fs.stat", { path: p, linuxUsername: linuxUser ?? "" })
      } catch (e: any) {
        throw mapWorkerError(e)
      }
    }),

  // ── mkdir (async) ────────────────────────────────────────────────────────────
  mkdir: protectedProcedure
    .input(z.object({ parentPath: z.string(), name: z.string().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      const parent = normalize(input.parentPath)
      await checkPathPerm(ctx, parent, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.mkdir", { linuxUsername: linuxUser ?? "", parentPath: parent, name: input.name }, ctx.user.userId)
      return { jobId }
    }),

  // ── copy (async) ─────────────────────────────────────────────────────────────
  copy: protectedProcedure
    .input(z.object({ src: z.string(), dstDir: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const src    = normalize(input.src)
      const dstDir = normalize(input.dstDir)
      await checkPathPerm(ctx, src,    "canRead")
      await checkPathPerm(ctx, dstDir, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.copy", { linuxUsername: linuxUser ?? "", src, dstDir }, ctx.user.userId)
      return { jobId }
    }),

  // ── move (async) ─────────────────────────────────────────────────────────────
  move: protectedProcedure
    .input(z.object({ src: z.string(), dstDir: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const src    = normalize(input.src)
      const dstDir = normalize(input.dstDir)
      await checkPathPerm(ctx, src,    "canWrite")
      await checkPathPerm(ctx, dstDir, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.move", { linuxUsername: linuxUser ?? "", src, dstDir }, ctx.user.userId)
      return { jobId }
    }),

  // ── rename (async) ───────────────────────────────────────────────────────────
  rename: protectedProcedure
    .input(z.object({ path: z.string(), newName: z.string().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      const p = normalize(input.path)
      if (input.newName.includes("/") || input.newName === "." || input.newName === "..") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid name" })
      }
      await checkPathPerm(ctx, p, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.rename", { linuxUsername: linuxUser ?? "", path: p, newName: input.newName }, ctx.user.userId)
      return { jobId }
    }),

  // ── delete (async) ───────────────────────────────────────────────────────────
  delete: protectedProcedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const p = normalize(input.path)
      await checkPathPerm(ctx, p, "canDelete")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.delete", { linuxUsername: linuxUser ?? "", path: p }, ctx.user.userId)
      return { jobId }
    }),

  // ── chmod (async, admin) ──────────────────────────────────────────────────────
  chmod: adminProcedure
    .input(z.object({ path: z.string(), mode: z.string().regex(/^[0-7]{3,4}$/) }))
    .mutation(async ({ ctx, input }) => {
      const jobId = await publishJob("fs.chmod", { path: normalize(input.path), mode: input.mode }, ctx.user.userId)
      return { jobId }
    }),

  // ── chown (async, admin) ──────────────────────────────────────────────────────
  chown: adminProcedure
    .input(z.object({ path: z.string(), owner: z.string().min(1), group: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const jobId = await publishJob("fs.chown", { path: normalize(input.path), owner: input.owner, group: input.group }, ctx.user.userId)
      return { jobId }
    }),
})
