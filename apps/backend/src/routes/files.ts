import type { FastifyInstance } from "fastify"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"
import { join, basename, normalize } from "node:path"
import { verifyToken, verifyFileToken, verifyWallpaperToken, isTokenBlacklisted } from "../trpc/auth"
import { prisma } from "@app/database"
import { publishJob, requestReadChunk, requestSync, writeChunk } from "../nats"
import { isWithinRoot } from "../utils/fs-guard"
import { guessMime, isInlineSafe } from "../utils/mime"
import {
  getUpload, setUpload, deleteUpload, startUploadGc,
  MAX_CHUNKS, type UploadState,
} from "../services/upload.service"
import { wallpaperPath } from "../services/wallpaper-storage"

// Parses a single-range "bytes=start-end" Range header against a known
// total size. Returns null when there's no usable range (caller should
// serve the full body), or { start, end, satisfiable: false } when the
// range is out of bounds (caller should respond 416).
function parseRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number; satisfiable: boolean } | null {
  if (!rangeHeader) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!m) return null
  const [, startStr, endStr] = m
  if (!startStr && !endStr) return null

  let start = startStr ? parseInt(startStr, 10) : undefined
  let end   = endStr   ? parseInt(endStr, 10)   : undefined

  if (start === undefined) {
    // Suffix range: "bytes=-500" = last 500 bytes.
    start = Math.max(0, size - (end ?? 0))
    end   = size - 1
  } else if (end === undefined) {
    end = size - 1
  }

  if (start > end || start >= size) return { start, end, satisfiable: false }
  return { start, end: Math.min(end, size - 1), satisfiable: true }
}

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

// Pulls one 4 MB chunk at a time from the worker via requestReadChunk and
// feeds it to whoever is reading the stream (Fastify, in this route) —
// bytes reach the HTTP response as they arrive instead of only after the
// whole file has been read into memory. Mirrors the existing chunked
// upload path (writeChunk / root.fs.write-chunk) in the opposite direction.
export function chunkedReadStream(
  filePath: string,
  linuxUser: string,
  allowedRoot: string,
  start: number,
  end: number,
): Readable {
  const READ_CHUNK = 4 * 1024 * 1024
  let offset = start
  return new Readable({
    async read() {
      if (offset > end) {
        this.push(null)
        return
      }
      try {
        const len = Math.min(READ_CHUNK, end - offset + 1)
        const chunk = await requestReadChunk(filePath, offset, len, linuxUser, allowedRoot)
        if (chunk.length === 0) {
          // EOF reached earlier than the stat-derived `end` (file shrank
          // mid-download) — end the stream early rather than erroring.
          this.push(null)
          return
        }
        offset += chunk.length
        this.push(chunk)
      } catch (err) {
        // Headers are already sent by this point, so the response can't
        // fail with a clean status code — destroying the stream aborts
        // the connection. Same failure mode the direct/createReadStream
        // branch below already has if the file disappears mid-stream.
        this.destroy(err as Error)
      }
    },
  })
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

  // ── GET /files/download?path=<path>&token=<file-token>[&inline=1] ────────
  //
  // `token` here is a short-lived (15m), single-path-scoped token minted via
  // fs.createFileToken — NOT the long-lived session JWT. <img>/<video> tags
  // and download links can't carry an Authorization header, so this keeps
  // the powerful 7-day session credential out of URLs, browser history, and
  // server access logs; a leaked file token only grants read access to the
  // one path it was minted for, for a few minutes.
  //
  // Default behavior (no `inline`) is unchanged: forces a save-as download
  // as application/octet-stream. `inline=1` is used by the in-app preview
  // (image/video/audio tags) — it sets a real Content-Type and an `inline`
  // disposition, and both branches below support HTTP Range so `<video>`
  // seeking works.
  app.get("/files/download", async (req, reply) => {
    const { path: rawPath, token, inline } = req.query as Record<string, string>
    if (!token || !rawPath) return reply.status(400).send("Missing params")
    const filePath = normalize(rawPath)

    let user: { userId: string; isAdmin: boolean }
    try {
      const payload = verifyFileToken(token)
      if (payload.path !== filePath) return reply.status(403).send("Forbidden")
      user = payload
    } catch {
      return reply.status(401).send("Unauthorized")
    }

    const allowedRoot = await resolveAllowedRoot(user.userId, user.isAdmin, filePath, "canRead")
    if (allowedRoot === undefined) return reply.status(403).send("Forbidden")

    const linuxUser = await getLinuxUser(user.userId)
    const name = basename(filePath)
    const mime = guessMime(name)
    // Only ever honor `inline=1` for passive media we know is safe to render
    // (image/video/audio, excluding SVG) — anything else silently falls
    // back to a forced attachment download, regardless of what the caller
    // requested. See isInlineSafe() for why.
    const isInline = inline === "1" && isInlineSafe(mime)

    reply.header(
      "Content-Disposition",
      isInline
        ? `inline; filename*=UTF-8''${encodeURIComponent(name)}`
        : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    reply.header("Content-Type", isInline ? mime : "application/octet-stream")
    reply.header("Accept-Ranges", "bytes")
    if (isInline) {
      // Defense in depth even within the allowlisted media types: stop the
      // browser from MIME-sniffing its way into treating the response as
      // HTML, and stop it from ever executing scripts/loading subresources
      // if it's framed or navigated to directly.
      reply.header("X-Content-Type-Options", "nosniff")
      reply.header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'")
      reply.header("Cross-Origin-Resource-Policy", "same-origin")
    }

    if (linuxUser) {
      let fileSize: number
      try {
        const s = await requestSync<{ type: string; size: number | null }>(
          "root.fs.stat",
          { path: filePath, linuxUsername: linuxUser, allowedRoot: allowedRoot ?? "" },
        )
        if (s.type !== "file" || s.size == null) return reply.status(400).send("Not a file")
        fileSize = s.size
      } catch (e: any) {
        if (e?.code === "EACCES") return reply.status(403).send("Permission denied")
        if (e?.code === "ENOENT") return reply.status(404).send("Not found")
        return reply.status(500).send(e?.message ?? "Stat failed")
      }

      const range = parseRange(req.headers.range, fileSize)
      if (range && !range.satisfiable) {
        reply.header("Content-Range", `bytes */${fileSize}`)
        return reply.status(416).send()
      }

      const start = range ? range.start : 0
      const end   = range ? range.end   : fileSize - 1
      if (range) {
        reply.header("Content-Range", `bytes ${start}-${end}/${fileSize}`)
        reply.header("Content-Length", String(end - start + 1))
        reply.status(206)
      } else {
        reply.header("Content-Length", String(fileSize))
      }
      return reply.send(chunkedReadStream(filePath, linuxUser, allowedRoot ?? "", start, end))
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

    const range = parseRange(req.headers.range, fileSize)
    if (range && !range.satisfiable) {
      reply.header("Content-Range", `bytes */${fileSize}`)
      return reply.status(416).send()
    }
    if (range) {
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${fileSize}`)
      reply.header("Content-Length", String(range.end - range.start + 1))
      return reply.status(206).send(createReadStream(filePath, { start: range.start, end: range.end }))
    }
    reply.header("Content-Length", String(fileSize))
    return reply.send(createReadStream(filePath))
  })

  // ── GET /files/wallpaper-image?token=<wallpaper-token> ───────────────────
  //
  // Same rationale as /files/download's token: a CSS background-image URL
  // can't carry an Authorization header, so this is gated by a short-lived
  // (15m) token scoped to exactly "this user's wallpaper", minted via
  // wallpaper.createImageToken — never the long-lived session JWT.
  app.get("/files/wallpaper-image", async (req, reply) => {
    const { token } = req.query as Record<string, string>
    if (!token) return reply.status(400).send("Missing token")

    let userId: string
    try {
      userId = verifyWallpaperToken(token).userId
    } catch {
      return reply.status(401).send("Unauthorized")
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { wallpaper: true } })
    const w = user?.wallpaper as { kind: string; ext?: string } | null
    if (w?.kind !== "image" || !w.ext) return reply.status(404).send("Not found")

    const filePath = wallpaperPath(userId, w.ext)
    let fileSize: number
    try {
      const s = await stat(filePath)
      fileSize = s.size
    } catch {
      return reply.status(404).send("Not found")
    }

    const mime = w.ext === "jpg" ? "image/jpeg" : `image/${w.ext}`
    reply.header("Content-Type", mime)
    reply.header("Cache-Control", "private, max-age=300")
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
  //   X-Total-Bytes    — optional; total upload size, used for a one-time
  //                       disk-space preflight when the upload is created
  //
  // Body: raw binary (application/octet-stream)
  //
  // Chunks are written by the root worker DIRECTLY into
  // <destDir>/.uploads-<uploadId>/ under the linuxUser's identity,
  // so no /tmp staging and no double disk usage.
  //
  // This route only STAGES chunks — it never triggers assembly. The
  // last-chunk response is just { ok: true, done: true }; the client must
  // call POST /files/upload/complete to actually publish the assemble job
  // (see below), which makes assembly explicit and retryable.
  //
  // Exempt from the global rate limiter: one request per CHUNK_SIZE (2MB,
  // see FileBrowserPanel.vue), so a large file alone can need thousands of
  // requests inside a minute — request-count throttling doesn't apply to an
  // already-authenticated, already-permission-checked transfer whose volume
  // scales with file size by design.
  app.post("/files/upload/chunk", { config: { rateLimit: false } }, async (req, reply) => {
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

      // Disk preflight — only done once, when the upload state is created.
      // X-Total-Bytes is optional (older clients / back-compat): if it's
      // absent or not a number, skip the check entirely rather than guessing.
      const totalBytesHeader = req.headers["x-total-bytes"] as string | undefined
      const totalBytes = totalBytesHeader !== undefined ? parseInt(totalBytesHeader, 10) : NaN
      if (!isNaN(totalBytes)) {
        try {
          const { free } = await requestSync<{ total: number; free: number }>(
            "root.fs.diskusage",
            { path: destDir, allowedRoot: allowedRoot ?? "" },
          )
          if (free < totalBytes * 1.02)
            return reply.status(507).send("Espace disque insuffisant pour cet upload")
        } catch (e: any) {
          if (e?.code === "EACCES") return reply.status(403).send("Permission denied")
          if (e?.code === "ENOENT") return reply.status(404).send("Not found")
          return reply.status(500).send(e?.message ?? "Disk usage check failed")
        }
      }

      // Staging dir lives directly inside destDir — same filesystem, no double-write.
      const stagingDir = join(destDir, `.uploads-${uploadId}`)
      const newState: UploadState = {
        received: new Set(), totalChunks, fileName, destDir, stagingDir,
        linuxUser, allowedRoot: allowedRoot ?? "", createdAt: Date.now(),
        totalBytes: isNaN(totalBytes) ? undefined : totalBytes,
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

    // All chunks staged — but assembly is no longer auto-triggered here.
    // The client must call POST /files/upload/complete (with the expected
    // sha256) to actually publish the assemble job; that makes assembly an
    // explicit, retryable step instead of tying it to whichever request
    // happens to land last. State is deliberately kept (not deleted) so a
    // retry of /complete can still find it — UPLOAD_TTL GC bounds the leak.
    return reply.send({ ok: true, done: state.received.size === totalChunks })
  })

  // ── POST /files/upload/complete ───────────────────────────────────────────
  //
  // Explicit, retryable assembly trigger. The chunk route only stages bytes
  // now (see above) — this is the one place that publishes fs.assemble, and
  // it can be called again (e.g. after a client crash/timeout waiting on the
  // job) as long as the upload state + staged chunks are still around: it
  // republishes the same assemble job from the still-staged chunks.
  //
  // Body: { uploadId: string, sha256: string } — sha256 is passed through to
  // the worker as expectedSha so assembly is verified end-to-end.
  app.post("/files/upload/complete", async (req, reply) => {
    const user = authFromRequest(req)
    if (!user) return reply.status(401).send("Unauthorized")

    const { uploadId, sha256 } = (req.body ?? {}) as { uploadId?: string; sha256?: string }
    if (!uploadId || !sha256) return reply.status(400).send("Missing uploadId or sha256")

    const state = getUpload(uploadId)
    if (!state) return reply.status(404).send("Unknown upload")

    if (state.received.size !== state.totalChunks) {
      const missing = Array.from({ length: state.totalChunks }, (_, i) => i)
        .filter(i => !state.received.has(i))
      return reply.status(409).send({ error: "Upload incomplete", missing })
    }

    const chunks   = Array.from({ length: state.totalChunks }, (_, i) => join(state.stagingDir, `${i}.part`))
    const destFile = join(state.destDir, state.fileName)

    const jobId = await publishJob(
      "fs.assemble",
      {
        linuxUsername: state.linuxUser,
        destFile,
        chunks,
        stagingDir: state.stagingDir,
        allowedRoot: state.allowedRoot,
        expectedSha: sha256,
      },
      user.userId,
    )

    return reply.send({ jobId })
  })

  // ── GET /files/upload/status?uploadId=<id> ────────────────────────────────
  //
  // Lets the client resume/retry a chunked upload by reporting which chunk
  // indices are already staged on disk, so it can skip re-sending them.
  //
  // Resolves via the in-memory upload state keyed by uploadId (like DELETE
  // /files/upload/cancel) — never hand-building a path from client input, so an
  // unknown/evicted uploadId always reports known:false. The staged set comes
  // from `state.received` (chunks the server successfully wrote and acked),
  // which is the authoritative, truncation-safe source: a chunk left partially
  // written by a crash was never acked, so it's correctly NOT reported as
  // staged (a disk listing could otherwise report a truncated `.part`, and a
  // resuming client would skip it → corrupt assembly).
  app.get("/files/upload/status", async (req, reply) => {
    const user = authFromRequest(req)
    if (!user) return reply.status(401).send("Unauthorized")

    const { uploadId } = req.query as Record<string, string>
    if (!uploadId) return reply.status(400).send("Missing uploadId")

    const state = getUpload(uploadId)
    if (!state) return reply.send({ known: false, staged: [] })

    const staged = [...state.received].sort((a, b) => a - b)
    return reply.send({ known: true, staged })
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
