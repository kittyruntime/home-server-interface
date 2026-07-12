import type { FastifyInstance } from "fastify"
import { basename, dirname } from "node:path"
import { prisma } from "@app/database"
import { verifyShareToken } from "../trpc/auth"
import { loadLink, resolveSubPath } from "../trpc/routers/shareLink"
import { chunkedReadStream } from "./files"
import { requestSync, requestZipTemp, requestRmTemp } from "../nats"
import { guessMime, isInlineSafe } from "../utils/mime"

export async function shareRoutes(app: FastifyInstance) {
  app.get("/s/:token/download", async (req, reply) => {
    const { token } = req.params as { token: string }
    const { path: rawPath, access, inline } = req.query as Record<string, string>

    const res = await loadLink(prisma, token)
    if (!res.ok) return reply.status(410).send("Link unavailable")
    const link = res.link

    // Password-protected links require a valid access token.
    if (link.passwordHash) {
      try {
        const p = verifyShareToken(access ?? "")
        if (p.shareLinkId !== link.id) return reply.status(401).send("Unauthorized")
      } catch {
        return reply.status(401).send("Unauthorized")
      }
    }

    // Resolve the target: for a dir link, use the (validated) subpath; a file
    // link ignores `path`.
    const abs = link.isDir ? resolveSubPath(link, rawPath ?? "") : link.path
    if (!abs) return reply.status(400).send("Invalid path")

    // Stat it (as the creator) — must be a file to download.
    let size: number
    try {
      const s = await requestSync<{ type: string; size: number | null }>(
        "root.fs.stat", { path: abs, linuxUsername: link.linuxUser, allowedRoot: link.allowedRoot },
      )
      if (s.type !== "file" || s.size == null) return reply.status(400).send("Not a file")
      size = s.size
    } catch {
      return reply.status(404).send("Not found")
    }

    // Atomic download-limit guard: only count/serve if under the cap and not expired.
    const updated = await prisma.shareLink.updateMany({
      where: {
        id: link.id,
        disabled: false,
        AND: [
          { OR: [{ maxDownloads: null }, { downloads: { lt: link.maxDownloads ?? Number.MAX_SAFE_INTEGER } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ],
      },
      data: { downloads: { increment: 1 }, lastAccessAt: new Date() },
    })
    if (updated.count === 0) return reply.status(410).send("Download limit reached")

    const name = basename(abs)
    const mime = guessMime(name)
    const isInline = inline === "1" && isInlineSafe(mime)
    reply.header(
      "Content-Disposition",
      `${isInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    reply.header("Content-Type", isInline ? mime : "application/octet-stream")
    reply.header("Cache-Control", "private, no-store")
    if (isInline) {
      reply.header("X-Content-Type-Options", "nosniff")
      reply.header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'")
      reply.header("Cross-Origin-Resource-Policy", "same-origin")
    }
    reply.header("Content-Length", String(size))

    // Audit the public download (no user identity — record token + ip; the
    // AuditLog schema has no free-text "detail" column, so the token goes
    // in `meta` as JSON and the resolved path in `target`).
    try {
      await prisma.auditLog.create({
        data: {
          userId: link.creatorId, action: "share.download", target: abs,
          meta: JSON.stringify({ token }), ip: req.ip,
        },
      })
    } catch {
      /* best-effort */
    }

    return reply.send(chunkedReadStream(abs, link.linuxUser, link.allowedRoot, 0, size - 1))
  })

  // Download a shared *folder* as a single .zip. The worker builds the archive
  // into its (PrivateTmp) temp dir with a hard disk guard, we stream it out via
  // read-chunk, then remove it — no temp file ever lands inside the shared tree.
  app.get("/s/:token/zip", async (req, reply) => {
    const { token } = req.params as { token: string }
    const { access } = req.query as Record<string, string>

    const res = await loadLink(prisma, token)
    if (!res.ok) return reply.status(410).send("Link unavailable")
    const link = res.link
    if (!link.isDir) return reply.status(400).send("Not a folder")

    if (link.passwordHash) {
      try {
        const p = verifyShareToken(access ?? "")
        if (p.shareLinkId !== link.id) return reply.status(401).send("Unauthorized")
      } catch {
        return reply.status(401).send("Unauthorized")
      }
    }

    // Build the archive first (disk-guarded, in the worker's temp dir) so a
    // failure doesn't consume a download.
    let tmp: { path: string; size: number }
    try {
      tmp = await requestZipTemp(link.path, link.linuxUser, link.allowedRoot)
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code === "NOSPC") return reply.status(507).send("Not enough server storage to build the archive")
      if (code === "TOOBIG") return reply.status(413).send("This folder is too large to download as a zip")
      if (code === "BUSY") return reply.status(503).send("The server is busy building archives; please try again shortly")
      return reply.status(500).send("Could not build the archive")
    }

    // The archive now exists in the worker's temp dir — it MUST always be
    // removed. Wire cleanup up immediately (idempotent), covering: a client that
    // already disconnected during the long build, any failure below, and the
    // normal end-of-response. (A leaked archive can't saturate disk — the worker
    // guards that — but it wastes temp space until the periodic sweep.)
    let cleaned = false
    const cleanup = () => { if (cleaned) return; cleaned = true; void requestRmTemp(tmp.path).catch(() => {}) }
    if (reply.raw.destroyed) { cleanup(); return reply }
    reply.raw.on("close", cleanup)

    // Atomic download-limit guard (same as /download). If we can't count it,
    // don't serve — and clean up the archive we just built.
    let updated: { count: number }
    try {
      updated = await prisma.shareLink.updateMany({
        where: {
          id: link.id,
          disabled: false,
          AND: [
            { OR: [{ maxDownloads: null }, { downloads: { lt: link.maxDownloads ?? Number.MAX_SAFE_INTEGER } }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          ],
        },
        data: { downloads: { increment: 1 }, lastAccessAt: new Date() },
      })
    } catch {
      cleanup()
      return reply.status(500).send("Could not serve the archive")
    }
    if (updated.count === 0) { cleanup(); return reply.status(410).send("Download limit reached") }

    const name = basename(link.path) + ".zip"
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    reply.header("Content-Type", "application/zip")
    reply.header("Cache-Control", "private, no-store")
    reply.header("Content-Length", String(tmp.size))

    try {
      await prisma.auditLog.create({
        data: {
          userId: link.creatorId, action: "share.download-zip", target: link.path,
          meta: JSON.stringify({ token }), ip: req.ip,
        },
      })
    } catch {
      /* best-effort */
    }

    return reply.send(chunkedReadStream(tmp.path, link.linuxUser, dirname(tmp.path), 0, tmp.size - 1))
  })
}
