import { z } from "zod"
import crypto from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { join, normalize, dirname } from "node:path"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"
import { accessiblePlaceIds } from "./place"
import { publishJob, requestSync, requestRead, writeChunk } from "../../nats"
import { isWithinRoot } from "../../utils/fs-guard"
import { looksBinary } from "../../utils/text-sniff"
import { signFileToken } from "../auth"

// Hard cap on what the text/code preview will read into memory and hand to
// the frontend editor — checked via stat() *before* reading, so an
// oversized file never gets pulled into memory for this path.
const MAX_TEXT_PREVIEW_BYTES = 3 * 1024 * 1024

// ── Shared helpers ────────────────────────────────────────────────────────────

async function getLinuxUser(ctx: { prisma: any; user: { userId: string } }): Promise<string | null> {
  const u = await ctx.prisma.user.findUnique({
    where:  { id: ctx.user.userId },
    select: { linuxUsername: true },
  })
  return u?.linuxUsername ?? null
}

// Returns the matched Place's root path so callers can pass it to the
// worker for symlink-aware containment checks, or null when the caller is
// an admin (unrestricted — no containment check performed by the worker).
async function checkPathPerm(
  ctx: { prisma: any; user: { userId: string; isAdmin: boolean } },
  path: string,
  flag: "canRead" | "canWrite" | "canDelete",
): Promise<string | null> {
  if (ctx.user.isAdmin) return null

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
  return place.path
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

      let allowedRoot: string | null = null
      if (!ctx.user.isAdmin) {
        const ids    = await accessiblePlaceIds(ctx)
        const places = await ctx.prisma.place.findMany({ where: { id: { in: ids } } })
        const place  = places.find((pl: { path: string }) => p === pl.path || p.startsWith(pl.path + "/"))
        if (!place) throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" })
        allowedRoot = place.path
      }

      const linuxUser = await getLinuxUser(ctx)
      try {
        if (!linuxUser) {
          if (allowedRoot && !(await isWithinRoot(p, allowedRoot))) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" })
          }
          return sortEntries(await listAsProcess(p))
        }
        const entries = await requestSync<FsEntry[]>("root.fs.list", { path: p, linuxUsername: linuxUser, allowedRoot: allowedRoot ?? "" })
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
      const allowedRoot = await checkPathPerm(ctx, p, "canRead")
      const linuxUser = await getLinuxUser(ctx)
      try {
        return await requestSync<{
          mode: string; owner: string; group: string; uid: number; gid: number; type: string; size: number | null
          mtime: string; ctime: string
        }>("root.fs.stat", { path: p, linuxUsername: linuxUser ?? "", allowedRoot: allowedRoot ?? "" })
      } catch (e: any) {
        throw mapWorkerError(e)
      }
    }),

  // ── diskUsage (sync) — filesystem capacity for a Place path ─────────────────
  diskUsage: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const p = normalize(input.path)
      const allowedRoot = await checkPathPerm(ctx, p, "canRead")
      try {
        return await requestSync<{ total: number; free: number }>(
          "root.fs.diskusage",
          { path: p, allowedRoot: allowedRoot ?? "" },
        )
      } catch (e: any) {
        throw mapWorkerError(e)
      }
    }),

  // ── createFileToken (sync) — mint a short-lived, path-scoped token for the
  // /files/download URL (img/video/audio src, download links) ─────────────────
  createFileToken: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const p = normalize(input.path)
      await checkPathPerm(ctx, p, "canRead")
      return { token: signFileToken(ctx.user.userId, ctx.user.isAdmin, p) }
    }),

  // ── readText (sync) — preview/edit content, with a binary + size guard ───────
  readText: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const p = normalize(input.path)
      const allowedRoot = await checkPathPerm(ctx, p, "canRead")
      const linuxUser = await getLinuxUser(ctx)

      let size: number | null
      try {
        if (linuxUser) {
          const s = await requestSync<{ type: string; size: number | null }>(
            "root.fs.stat",
            { path: p, linuxUsername: linuxUser, allowedRoot: allowedRoot ?? "" },
          )
          if (s.type !== "file") throw new TRPCError({ code: "BAD_REQUEST", message: "Not a file" })
          size = s.size
        } else {
          if (allowedRoot && !(await isWithinRoot(p, allowedRoot))) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" })
          }
          const s = await stat(p)
          if (!s.isFile()) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a file" })
          size = s.size
        }
      } catch (e: any) {
        throw mapWorkerError(e)
      }

      if (size != null && size > MAX_TEXT_PREVIEW_BYTES) {
        return { ok: false as const, reason: "too-large" as const, size }
      }

      let data: Buffer
      try {
        data = linuxUser
          ? await requestRead(p, linuxUser, allowedRoot ?? "")
          : await readFile(p)
      } catch (e: any) {
        throw mapWorkerError(e)
      }

      if (looksBinary(data)) {
        return { ok: false as const, reason: "binary" as const, size: data.length }
      }

      return { ok: true as const, content: data.toString("utf-8"), size: data.length }
    }),

  // ── writeText (async) — save editor content, reusing the upload pipeline ────
  //
  // There's no "overwrite whole file" worker command; this reuses the exact
  // same chunked-upload + assemble path as a real file upload (single
  // in-memory chunk), which already truncates-and-overwrites an existing
  // destination file (apps/root-worker/fs.go doAssemble, O_TRUNC). Zero
  // changes to the root-worker needed.
  writeText: protectedProcedure
    .input(z.object({ path: z.string(), content: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const p = normalize(input.path)
      const allowedRoot = await checkPathPerm(ctx, p, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      if (!linuxUser) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "User has no Linux account configured" })
      }

      const uploadId   = crypto.randomUUID()
      const destDir    = dirname(p)
      const stagingDir = join(destDir, `.uploads-${uploadId}`)
      const data       = Buffer.from(input.content, "utf-8")

      try {
        await writeChunk({
          uploadId, chunkIndex: 0,
          destDir, linuxUsername: linuxUser, allowedRoot: allowedRoot ?? "",
          data,
        })
      } catch (e: any) {
        throw mapWorkerError(e)
      }

      const jobId = await publishJob(
        "fs.assemble",
        {
          linuxUsername: linuxUser,
          destFile:    p,
          chunks:      [join(stagingDir, "0.part")],
          stagingDir,
          allowedRoot: allowedRoot ?? "",
        },
        ctx.user.userId,
      )
      return { jobId }
    }),

  // ── mkdir (async) ────────────────────────────────────────────────────────────
  mkdir: protectedProcedure
    .input(z.object({ parentPath: z.string(), name: z.string().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      const parent = normalize(input.parentPath)
      const allowedRoot = await checkPathPerm(ctx, parent, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.mkdir", { linuxUsername: linuxUser ?? "", parentPath: parent, name: input.name, allowedRoot: allowedRoot ?? "" }, ctx.user.userId)
      return { jobId }
    }),

  // ── copy (async) ─────────────────────────────────────────────────────────────
  copy: protectedProcedure
    .input(z.object({ src: z.string(), dstDir: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const src    = normalize(input.src)
      const dstDir = normalize(input.dstDir)
      const srcRoot = await checkPathPerm(ctx, src,    "canRead")
      const dstRoot = await checkPathPerm(ctx, dstDir, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.copy", { linuxUsername: linuxUser ?? "", src, dstDir, allowedRoot: srcRoot ?? "", dstAllowedRoot: dstRoot ?? "" }, ctx.user.userId)
      return { jobId }
    }),

  // ── move (async) ─────────────────────────────────────────────────────────────
  move: protectedProcedure
    .input(z.object({ src: z.string(), dstDir: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const src    = normalize(input.src)
      const dstDir = normalize(input.dstDir)
      const srcRoot = await checkPathPerm(ctx, src,    "canWrite")
      const dstRoot = await checkPathPerm(ctx, dstDir, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.move", { linuxUsername: linuxUser ?? "", src, dstDir, allowedRoot: srcRoot ?? "", dstAllowedRoot: dstRoot ?? "" }, ctx.user.userId)
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
      const allowedRoot = await checkPathPerm(ctx, p, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.rename", { linuxUsername: linuxUser ?? "", path: p, newName: input.newName, allowedRoot: allowedRoot ?? "" }, ctx.user.userId)
      return { jobId }
    }),

  // ── delete (async) ───────────────────────────────────────────────────────────
  delete: protectedProcedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const p = normalize(input.path)
      const allowedRoot = await checkPathPerm(ctx, p, "canDelete")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob("fs.delete", { linuxUsername: linuxUser ?? "", path: p, allowedRoot: allowedRoot ?? "" }, ctx.user.userId)
      return { jobId }
    }),

  // ── zip (async) ──────────────────────────────────────────────────────────────
  zip: protectedProcedure
    .input(z.object({
      paths:   z.array(z.string()).min(1),
      destDir: z.string(),
      name:    z.string().min(1).max(255)
        .refine(n => !n.includes('/') && !n.includes('\\') && n !== '.' && n !== '..' && !n.includes('\x00'), 'invalid archive name'),
    }))
    .mutation(async ({ ctx, input }) => {
      const destDir = normalize(input.destDir)
      const paths   = input.paths.map(p => normalize(p))
      const allowedRoot = await checkPathPerm(ctx, destDir, "canWrite")
      for (const p of paths) await checkPathPerm(ctx, p, "canRead")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob(
        "fs.zip",
        { linuxUsername: linuxUser ?? "", paths, dstDir: destDir, name: input.name, allowedRoot: allowedRoot ?? "" },
        ctx.user.userId,
      )
      return { jobId }
    }),

  // ── unzip (async) ────────────────────────────────────────────────────────────
  unzip: protectedProcedure
    .input(z.object({
      path:    z.string(),
      destDir: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const src     = normalize(input.path)
      const destDir = normalize(input.destDir)
      const allowedRoot    = await checkPathPerm(ctx, src,     "canRead")
      const dstAllowedRoot = await checkPathPerm(ctx, destDir, "canWrite")
      const linuxUser = await getLinuxUser(ctx)
      const jobId = await publishJob(
        "fs.unzip",
        { linuxUsername: linuxUser ?? "", src, dstDir: destDir, allowedRoot: allowedRoot ?? "", dstAllowedRoot: dstAllowedRoot ?? "" },
        ctx.user.userId,
      )
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
