import type { FastifyInstance } from "fastify"
import { basename } from "node:path"
import { prisma } from "@app/database"
import { verifyShareToken } from "../trpc/auth"
import { loadLink, resolveSubPath } from "../trpc/routers/shareLink"
import { chunkedReadStream } from "./files"
import { requestSync } from "../nats"
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

    // Atomic download-limit guard: only count/serve if under the cap.
    const updated = await prisma.shareLink.updateMany({
      where: {
        id: link.id, disabled: false,
        OR: [{ maxDownloads: null }, { downloads: { lt: link.maxDownloads ?? Number.MAX_SAFE_INTEGER } }],
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
    reply.header("Accept-Ranges", "bytes")
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
}
