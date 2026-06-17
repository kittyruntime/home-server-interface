import type { FastifyInstance } from "fastify"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { join, basename, normalize } from "node:path"
import { verifyToken, isTokenBlacklisted } from "../trpc/auth"
import { prisma } from "@app/database"
import { publishJob, requestRead, writeChunk } from "../nats"
import { isWithinRoot } from "../utils/fs-guard"
import {
  getUpload, setUpload, deleteUpload, startUploadGc,
  MAX_CHUNKS, type UploadState,
} from "../services/upload.service"

// ── Shared helpers ────────────────────────────────────────────────────────────

// Returns the matched Place's root path on success (null when the caller is
// an admin — unrestricted), or undefined when access is denied.
async function resolveAllowedRoot(
  userId: string,
  isAdmin: boolean,
  path: string,
  flag: "canRead" | "canWrite",
): Promise<string | null | undefined> {
  if (isAdmin) return null
  const places = await prisma.place.findMany()
  const place  = places.find(p => path === p.path || path.startsWith(p.path + "/"))
  if (!place) return undefined
  const roleIds = (
    await prisma.userRole.findMany({ where: { userId }, select: { roleId: true } })
  ).map(r => r.roleId)
  const [u, r] = await Promise.all([
    prisma.userPlacePermission.findFirst({ where: { userId, placeId: place.id, [flag]: true } }),
    roleIds.length
      ? prisma.rolePlacePermission.findFirst({ where: { roleId: { in: roleIds }, placeId: place.id, [flag]: true } })
      : null,
  ])
  return (u || r) ? place.path : undefined
}

async function getLinuxUser(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { linuxUsername: true } })
  return u?.linuxUsername ?? null
}

function authFromRequest(req: { headers: { authorization?: string } }) {
  const h = req.headers.authorization
  if (!h?.startsWith("Bearer ")) return null
  try {
    const payload = verifyToken(h.slice(7))
    if (isTokenBlacklisted(payload.jti)) return null
    return payload
  } catch {
    return null
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function fileRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  )

  // Clean up uploads that have been silent for more than UPLOAD_TTL_MS.
  startUploadGc((id, state) => {
    app.log.warn({ uploadId: id }, "Stale upload evicted by GC")
    publishJob("fs.delete", { linuxUsername: state.linuxUser, path: state.stagingDir, allowedRoot: state.allowedRoot })
      .catch(err => app.log.error(err, "Failed to clean up stale upload staging dir"))
  })

  // ── GET /files/download?path=<path>&token=<jwt> ───────────────────────────
  app.get("/files/download", async (req, reply) => {
    const { path: filePath, token } = req.query as Record<string, string>
    if (!token || !filePath) return reply.status(400).send("Missing params")

    let user: { userId: string; isAdmin: boolean }
    try {
      const payload = verifyToken(token)
      if (isTokenBlacklisted(payload.jti)) return reply.status(401).send("Unauthorized")
      user = payload
    } catch {
      return reply.status(401).send("Unauthorized")
    }

    const allowedRoot = await resolveAllowedRoot(user.userId, user.isAdmin, filePath, "canRead")
    if (allowedRoot === undefined) return reply.status(403).send("Forbidden")

    const linuxUser = await getLinuxUser(user.userId)
    const name = basename(filePath)
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    reply.header("Content-Type", "application/octet-stream")

    if (linuxUser) {
      let data: Buffer
      try {
        data = await requestRead(filePath, linuxUser, allowedRoot ?? "")
      } catch (e: any) {
        if (e?.code === "EACCES") return reply.status(403).send("Permission denied")
        if (e?.code === "ENOENT") return reply.status(404).send("Not found")
        return reply.status(500).send(e?.message ?? "Read failed")
      }
      reply.header("Content-Length", String(data.length))
      return reply.send(data)
    }

    if (allowedRoot && !(await isWithinRoot(filePath, allowedRoot)))
      return reply.status(403).send("Forbidden")

    let fileSize: number
    try {
      const s = await stat(filePath)
      if (!s.isFile()) return reply.status(400).send("Not a file")
      fileSize = s.size
    } catch {
      return reply.status(404).send("Not found")
    }
    reply.header("Content-Length", String(fileSize))
    return reply.send(createReadStream(filePath))
  })

  // ── POST /files/upload/chunk ──────────────────────────────────────────────
  //
  // Headers:
  //   X-Upload-Id      — unique ID per file upload (UUID)
  //   X-Chunk-Index    — 0-based chunk index
  //   X-Total-Chunks   — total number of chunks
  //   X-File-Name      — URI-encoded filename
  //   X-Dest-Dir       — URI-encoded destination directory
  //
  // Body: raw binary (application/octet-stream)
  //
  // Chunks are written by the root worker DIRECTLY into
  // <destDir>/.uploads-<uploadId>/ under the linuxUser's identity,
  // so no /tmp staging and no double disk usage.
  //
  // The last-chunk response includes { done: true, jobId } for polling.
  app.post("/files/upload/chunk", async (req, reply) => {
    const user = authFromRequest(req)
    if (!user) return reply.status(401).send("Unauthorized")

    const uploadId    = req.headers["x-upload-id"]    as string
    const chunkIndex  = parseInt(req.headers["x-chunk-index"]  as string, 10)
    const totalChunks = parseInt(req.headers["x-total-chunks"] as string, 10)
    const rawFileName = decodeURIComponent(req.headers["x-file-name"] as string ?? "")
    const fileName    = basename(rawFileName)
    const destDir     = normalize(decodeURIComponent(req.headers["x-dest-dir"]  as string ?? ""))

    if (!uploadId || isNaN(chunkIndex) || isNaN(totalChunks) || !fileName || !destDir)
      return reply.status(400).send("Missing upload metadata")

    if (totalChunks > MAX_CHUNKS)
      return reply.status(400).send(`totalChunks exceeds maximum of ${MAX_CHUNKS}`)

    if (chunkIndex < 0 || chunkIndex >= totalChunks)
      return reply.status(400).send("chunkIndex out of range")

    const allowedRoot = await resolveAllowedRoot(user.userId, user.isAdmin, destDir, "canWrite")
    if (allowedRoot === undefined) return reply.status(403).send("Forbidden")

    // Resolve state (init on first chunk).
    let state = getUpload(uploadId)
    if (!state) {
      const linuxUser = await getLinuxUser(user.userId)
      if (!linuxUser) return reply.status(500).send("User has no Linux account configured")
      // Staging dir lives directly inside destDir — same filesystem, no double-write.
      const stagingDir = join(destDir, `.uploads-${uploadId}`)
      const newState: UploadState = {
        received: new Set(), totalChunks, fileName, destDir, stagingDir,
        linuxUser, allowedRoot: allowedRoot ?? "", createdAt: Date.now(),
      }
      setUpload(uploadId, newState)
      state = newState
    }

    // Delegate the write to the worker: it creates the staging dir on first
    // chunk and writes the binary data as the linuxUser (seteuid).
    try {
      await writeChunk({
        uploadId,
        chunkIndex,
        destDir:       state.destDir,
        linuxUsername: state.linuxUser,
        allowedRoot:   state.allowedRoot,
        data:          req.body as Buffer,
      })
    } catch (e: any) {
      deleteUpload(uploadId)
      if (e?.code === "EACCES") return reply.status(403).send("Permission denied")
      if (e?.code === "ENOSPC") return reply.status(507).send("Insufficient storage")
      return reply.status(500).send(e?.message ?? "Chunk write failed")
    }

    state.received.add(chunkIndex)
    if (state.received.size < totalChunks) return reply.send({ ok: true, done: false })

    // All chunks received — publish async assemble job.
    const chunks   = Array.from({ length: totalChunks }, (_, i) => join(state.stagingDir, `${i}.part`))
    const destFile = join(state.destDir, state.fileName)

    const jobId = await publishJob(
      "fs.assemble",
      {
        linuxUsername: state.linuxUser,
        destFile,
        chunks,
        stagingDir: state.stagingDir,
        allowedRoot: state.allowedRoot,
      },
      user.userId,
    )
    deleteUpload(uploadId)

    return reply.send({ ok: true, done: true, jobId })
  })

  // ── DELETE /files/upload/cancel ───────────────────────────────────────────
  app.delete("/files/upload/cancel", async (req, reply) => {
    const user = authFromRequest(req)
    if (!user) return reply.status(401).send("Unauthorized")

    const { uploadId } = (req.body ?? {}) as { uploadId?: string }
    if (!uploadId) return reply.status(400).send("Missing uploadId")

    const state = getUpload(uploadId)
    if (!state) return reply.send({ ok: true })

    deleteUpload(uploadId)

    publishJob(
      "fs.delete",
      { linuxUsername: state.linuxUser, path: state.stagingDir, allowedRoot: state.allowedRoot },
    ).catch(err => app.log.error(err, "Failed to clean up upload staging dir on cancel"))

    return reply.send({ ok: true })
  })
}
