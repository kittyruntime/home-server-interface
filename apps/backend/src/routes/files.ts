import type { FastifyInstance } from "fastify"
import { assertVolumeAvailable } from "../services/volume-guard"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"
import { join, basename, normalize } from "node:path"
import { verifyFileToken, verifyWallpaperToken } from "../trpc/auth"
import { prisma } from "@app/database"
import { publishJob, requestReadChunk, requestSync, writeChunk } from "../nats"
import { isWithinRoot } from "../utils/fs-guard"
import { guessMime, isInlineSafe } from "../utils/mime"
import {
  getUpload, getUploadForOwner, claimUpload, markUploadActive, hasUploadFinalizationStarted,
  beginUploadWrite, endUploadWrite, waitForUploadWrites, cancelUpload,
  deleteUploadIfSame, markUploadCancellationPending, isUploadCancellationPending,
  clearUploadCancellation, resolveUploadTotalBytes, getUploadPhase, startUploadGc,
  MAX_CHUNKS, type UploadState,
} from "../services/upload.service"
import { wallpaperPath } from "../services/wallpaper-storage"
import { authenticateRequest } from "../utils/request-auth"

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANCEL_CLEANUP_WAIT_MS = 3_000

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
  const groupIds = (
    await prisma.userGroup.findMany({ where: { userId }, select: { groupId: true } })
  ).map(g => g.groupId)
  const [u, g] = await Promise.all([
    prisma.userPlacePermission.findFirst({ where: { userId, placeId: place.id, [flag]: true } }),
    groupIds.length
      ? prisma.groupPlacePermission.findFirst({ where: { groupId: { in: groupIds }, placeId: place.id, [flag]: true } })
      : null,
  ])
  return (u || g) ? place.path : undefined
}

async function getLinuxUser(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
  return u?.username ?? null
}

class UploadFinalizeHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseBody: unknown,
  ) {
    super(typeof responseBody === "string" ? responseBody : "Upload finalization failed")
  }
}

async function finalizeUploadState(
  state: UploadState,
  user: { userId: string; isAdmin: boolean },
  expectedSha: string,
): Promise<string> {
  if (state.received.size !== state.totalChunks) {
    const missing = Array.from({ length: state.totalChunks }, (_, i) => i)
      .filter(i => !state.received.has(i))
    throw new UploadFinalizeHttpError(409, { error: "Upload incomplete", missing })
  }

  // Permissions and the Linux identity can change during a long upload.
  // Revalidate both before publishing the final atomic rename.
  try {
    await assertVolumeAvailable(state.destDir)
  } catch (e) {
    throw new UploadFinalizeHttpError(409, e instanceof Error ? e.message : String(e))
  }
  const allowedRoot = await resolveAllowedRoot(user.userId, user.isAdmin, state.destDir, "canWrite")
  if (allowedRoot === undefined) throw new UploadFinalizeHttpError(403, "Forbidden")
  const linuxUser = await getLinuxUser(user.userId)
  if (!linuxUser) {
    throw new UploadFinalizeHttpError(500, "User has no Linux account configured")
  }

  // A lost HTTP response must not enqueue a second rename after the first
  // finalize succeeded. Reuse pending/running/completed jobs; only a failed
  // job is eligible for an explicit retry against the same staged file.
  if (state.finalizeJobId) {
    const priorJob = await prisma.job.findUnique({
      where: { id: state.finalizeJobId },
      select: { status: true },
    })
    if (!priorJob || priorJob.status !== "failed") return state.finalizeJobId
    state.finalizeJobId = undefined
  }

  const jobId = await publishJob(
    "fs.finalize",
    {
      linuxUsername: linuxUser,
      tempFile:      state.tempPath,
      destFile:      join(state.destDir, state.fileName),
      allowedRoot:   allowedRoot ?? "",
      expectedSha,
    },
    user.userId,
  )
  state.finalizeJobId = jobId
  state.linuxUser = linuxUser
  state.allowedRoot = allowedRoot ?? ""
  return jobId
}

async function waitForCleanupCompletion(jobId: string): Promise<boolean> {
  const deadline = Date.now() + CANCEL_CLEANUP_WAIT_MS
  while (Date.now() < deadline) {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { status: true },
    })
    if (job?.status === "completed") return true
    // A failed attempt can still be redelivered by JetStream, so keep polling
    // within the bounded window. If it never completes, the caller retains the
    // cancelled state/tombstone and a late retry cannot hit a reused id.
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

async function uploadFinalizationIsActive(state: UploadState): Promise<boolean> {
  if (state.finalizePromise || (state.finalizeSha && !state.finalizeJobId)) return true
  if (!state.finalizeJobId) return false
  const job = await prisma.job.findUnique({
    where: { id: state.finalizeJobId },
    select: { status: true },
  })
  // Missing state is ambiguous and therefore treated as active; only an
  // observed terminal job makes deletion of the staging path safe.
  return !job || job.status === "pending" || job.status === "running"
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
    markUploadCancellationPending(id, state.ownerUserId)
    publishJob("fs.delete", { linuxUsername: state.linuxUser, path: state.tempPath, allowedRoot: state.allowedRoot })
      .then(async jobId => {
        if (await waitForCleanupCompletion(jobId)) {
          clearUploadCancellation(id, state.ownerUserId)
        }
      })
      .catch(err => app.log.error(err, "Failed to clean up stale upload temp file"))
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

    let userId: string
    try {
      const payload = verifyFileToken(token)
      if (payload.path !== filePath) return reply.status(403).send("Forbidden")
      userId = payload.userId
    } catch {
      return reply.status(401).send("Unauthorized")
    }

    // File tokens are short-lived and path-scoped, but account deletion and
    // permission changes still take effect immediately. Never authorize from
    // role claims embedded when the token was minted.
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    })
    if (!currentUser) return reply.status(401).send("Unauthorized")

    const allowedRoot = await resolveAllowedRoot(userId, currentUser.isAdmin, filePath, "canRead")
    if (allowedRoot === undefined) return reply.status(403).send("Forbidden")

    const linuxUser = await getLinuxUser(userId)
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
  //   X-Chunk-Offset   — byte offset of this chunk within the final file
  //   X-File-Name      — URI-encoded filename
  //   X-Dest-Dir       — URI-encoded destination directory
  //   X-Total-Bytes    — required on the first chunk; total upload size,
  //                       used for a one-time disk-space preflight and to
  //                       bound every subsequent chunk's byte offset
  //
  // Body: raw binary (application/octet-stream)
  //
  // Chunks are written by the root worker DIRECTLY at their byte offset into
  // <destDir>/.upload-<uploadId>.part under the linuxUser's identity — a
  // single temp file, no staging dir, no separate assembly pass.
  //
  // This route only WRITES chunks — it never triggers finalize. The
  // last-chunk response is just { ok: true, done: true }; the client must
  // call POST /files/upload/complete to actually publish the finalize job
  // (see below), which makes finalize explicit and retryable.
  //
  // Exempt from the global rate limiter: one request per CHUNK_SIZE (2MB,
  // see FileBrowserPanel.vue), so a large file alone can need thousands of
  // requests inside a minute — request-count throttling doesn't apply to an
  // already-authenticated, already-permission-checked transfer whose volume
  // scales with file size by design.
  app.post("/files/upload/chunk", { config: { rateLimit: false } }, async (req, reply) => {
    const user = await authenticateRequest(req)
    if (!user) return reply.status(401).send("Unauthorized")

    const uploadId    = req.headers["x-upload-id"] as string
    const chunkIndex  = Number(req.headers["x-chunk-index"])
    const totalChunks = Number(req.headers["x-total-chunks"])
    const chunkOffset = Number(req.headers["x-chunk-offset"])
    let rawFileName: string
    let destDir: string
    try {
      rawFileName = decodeURIComponent(req.headers["x-file-name"] as string ?? "")
      destDir = normalize(decodeURIComponent(req.headers["x-dest-dir"] as string ?? ""))
    } catch {
      return reply.status(400).send("Invalid upload metadata encoding")
    }
    const fileName = basename(rawFileName)
    const totalBytesHeader = req.headers["x-total-bytes"] as string | undefined

    if (!uploadId || !Number.isSafeInteger(chunkIndex) || !Number.isSafeInteger(totalChunks) ||
        !Number.isSafeInteger(chunkOffset) || !fileName || fileName === "." || fileName === ".." || fileName.includes("\0") ||
        !destDir.startsWith("/") || destDir.includes("\0"))
      return reply.status(400).send("Missing upload metadata")

    // uploadId ends up in a filename on disk — enforce an opaque-token shape.
    if (!UPLOAD_ID_RE.test(uploadId))
      return reply.status(400).send("Invalid upload id")

    if (chunkOffset < 0 || (chunkIndex === 0 && chunkOffset !== 0))
      return reply.status(400).send("Invalid chunk offset")

    if (totalChunks < 1 || totalChunks > MAX_CHUNKS)
      return reply.status(400).send(`totalChunks exceeds maximum of ${MAX_CHUNKS}`)

    if (chunkIndex < 0 || chunkIndex >= totalChunks)
      return reply.status(400).send("chunkIndex out of range")

    // Resolve existing state before parsing X-Total-Bytes: the header is
    // required to initialize an upload, but remains optional on later chunks
    // for compatibility with the original route contract.
    let state = getUpload(uploadId)
    if (state && state.ownerUserId !== user.userId) {
      // Do not reveal whether another user's opaque upload id exists.
      return reply.status(404).send("Unknown upload")
    }
    if (state) markUploadActive(state)
    if (state?.cancelled || isUploadCancellationPending(uploadId, user.userId)) {
      return reply.status(409).send("Upload is being cancelled")
    }
    if (state && hasUploadFinalizationStarted(state)) {
      return reply.status(409).send("Upload finalization has already started")
    }

    const totalBytes = resolveUploadTotalBytes(totalBytesHeader, state)
    if (totalBytes === null) {
      return reply.status(400).send("Missing or invalid X-Total-Bytes")
    }

    try {
      await assertVolumeAvailable(destDir)
    } catch (e) {
      return reply.status(409).send(e instanceof Error ? e.message : String(e))
    }
    const allowedRoot = await resolveAllowedRoot(user.userId, user.isAdmin, destDir, "canWrite")
    if (allowedRoot === undefined) return reply.status(403).send("Forbidden")
    const linuxUser = await getLinuxUser(user.userId)
    if (!linuxUser) return reply.status(500).send("User has no Linux account configured")

    // Resolve state (init on first chunk).
    if (!state) {
      // Disk preflight — only done once, when the upload state is created.
      try {
        const { free } = await requestSync<{ total: number; free: number }>(
          "root.fs.diskusage",
          { path: destDir, allowedRoot: allowedRoot ?? "" },
        )
        if (free < totalBytes * 1.02)
          return reply.status(507).send("Not enough disk space for this upload")
      } catch (e: any) {
        if (e?.code === "EACCES") return reply.status(403).send("Permission denied")
        if (e?.code === "ENOENT") return reply.status(404).send("Not found")
        return reply.status(500).send(e?.message ?? "Disk usage check failed")
      }

      // Temp file lives directly inside destDir — same filesystem, so the
      // finalize rename is atomic and there is no double-write.
      const tempPath = join(destDir, `.upload-${uploadId}.part`)
      const newState: UploadState = {
        ownerUserId: user.userId,
        received: new Set(), totalChunks, fileName, destDir, tempPath,
        linuxUser, allowedRoot: allowedRoot ?? "", createdAt: Date.now(), lastActivityAt: Date.now(),
        totalBytes, activeWrites: 0, cancelled: false, writeIdleWaiters: [],
      }
      // A concurrent first chunk or cancellation may have won during the
      // asynchronous preflight. Claim checks both atomically in this process.
      const claim = claimUpload(uploadId, newState)
      if (claim.cancelled) return reply.status(409).send("Upload is being cancelled")
      state = claim.state
      if (state.ownerUserId !== user.userId) return reply.status(404).send("Unknown upload")
    }
    if (
      state.totalChunks !== totalChunks || state.totalBytes !== totalBytes ||
      state.fileName !== fileName || state.destDir !== destDir
    ) {
      return reply.status(409).send("Upload metadata does not match the existing upload")
    }

    const body = req.body as Buffer
    if (!Buffer.isBuffer(body)) return reply.status(400).send("Missing chunk data")
    if (chunkOffset + body.length > state.totalBytes)
      return reply.status(400).send("Chunk exceeds declared upload size")
    if (!beginUploadWrite(state)) {
      return reply.status(409).send("Upload no longer accepts chunks")
    }

    // Delegate the write to the worker: it writes the binary data at the
    // given byte offset into the temp file as the linuxUser (seteuid).
    try {
      await writeChunk({
        uploadId,
        offset:        chunkOffset,
        destDir:       state.destDir,
        linuxUsername: linuxUser,
        allowedRoot:   allowedRoot ?? "",
        data:          body,
      })
      state.received.add(chunkIndex)
      state.linuxUser = linuxUser
      state.allowedRoot = allowedRoot ?? ""
    } catch (e: any) {
      // Keep the state: a timeout may happen after the worker wrote the bytes,
      // and retrying the same offset safely overwrites them. Dropping the state
      // here would forget all earlier chunks and make resume/finalize fail.
      markUploadActive(state)
      if (e?.code === "EACCES") return reply.status(403).send("Permission denied")
      if (e?.code === "ENOSPC") return reply.status(507).send("Insufficient storage")
      return reply.status(500).send(e?.message ?? "Chunk write failed")
    } finally {
      endUploadWrite(state)
      markUploadActive(state)
    }

    // All chunks written — but finalize is no longer auto-triggered here.
    // The client must call POST /files/upload/complete (with the expected
    // sha256) to actually publish the finalize job; that makes finalize an
    // explicit, retryable step instead of tying it to whichever request
    // happens to land last. State is deliberately kept (not deleted) so a
    // retry of /complete can still find it — UPLOAD_TTL GC bounds the leak.
    return reply.send({ ok: true, done: state.received.size === totalChunks })
  })

  // ── POST /files/upload/complete ───────────────────────────────────────────
  //
  // Explicit, retryable finalize trigger. The chunk route only writes bytes
  // into the upload temp file now (see above) — this is the one place that
  // publishes fs.finalize, and it can be called again (e.g. after a client
  // crash/timeout waiting on the job) as long as the upload state + temp file
  // are still around: it republishes the same finalize job against the same
  // temp file. The worker hashes the temp file, verifies it against
  // expectedSha, and atomically renames it to destFile.
  //
  // Body: { uploadId: string, sha256: string } — sha256 is passed through to
  // the worker as expectedSha so the write is verified end-to-end.
  app.post("/files/upload/complete", async (req, reply) => {
    const user = await authenticateRequest(req)
    if (!user) return reply.status(401).send("Unauthorized")

    const { uploadId, sha256 } = (req.body ?? {}) as { uploadId?: string; sha256?: string }
    if (!uploadId || !sha256) return reply.status(400).send("Missing uploadId or sha256")

    const state = getUploadForOwner(uploadId, user.userId)
    if (!state) return reply.status(404).send("Unknown upload")
    if (state.cancelled) return reply.status(404).send("Unknown upload")

    if (typeof sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(sha256)) {
      return reply.status(400).send("Invalid sha256")
    }
    const expectedSha = sha256.toLowerCase()

    // Set one shared finalization promise before any permission/database await.
    // This is both the write lock and the idempotency primitive: concurrent
    // completion requests with the same checksum await the exact same work.
    if (state.activeWrites > 0) {
      return reply.status(409).send("Upload still has chunk writes in progress")
    }
    if (state.finalizeSha && state.finalizeSha !== expectedSha) {
      return reply.status(409).send("Upload is already being finalized with a different checksum")
    }
    let finalizePromise = state.finalizePromise
    if (!finalizePromise) {
      state.finalizeSha = expectedSha
      finalizePromise = finalizeUploadState(state, user, expectedSha)
      state.finalizePromise = finalizePromise
    }

    // Uploads land through this raw HTTP route rather than a tRPC fs.* mutation
    // (chunking binary data doesn't fit tRPC well), so they never pass through
    // the auditLog middleware every other fs write gets automatically — logged
    // here by hand instead, once per upload rather than once per chunk.
    const uploadTarget = join(state.destDir, state.fileName)
    try {
      const jobId = await finalizePromise
      markUploadActive(state)
      void prisma.auditLog.create({
        data: { userId: user.userId, action: "files.upload", target: uploadTarget, ip: req.ip, success: true },
      }).catch(() => {})
      return reply.send({ jobId })
    } catch (error) {
      if (!state.finalizeJobId) state.finalizeSha = undefined
      void prisma.auditLog.create({
        data: { userId: user.userId, action: "files.upload", target: uploadTarget, ip: req.ip, success: false },
      }).catch(() => {})
      if (error instanceof UploadFinalizeHttpError) {
        return reply.status(error.statusCode).send(error.responseBody)
      }
      throw error
    } finally {
      if (state.finalizePromise === finalizePromise) state.finalizePromise = undefined
    }
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
    const user = await authenticateRequest(req)
    if (!user) return reply.status(401).send("Unauthorized")

    const { uploadId } = req.query as Record<string, string>
    if (!uploadId) return reply.status(400).send("Missing uploadId")

    const state = getUploadForOwner(uploadId, user.userId)
    if (!state) return reply.send({ known: false, staged: [] })
    if (state.cancelled) return reply.send({ known: false, staged: [] })

    markUploadActive(state)
    const staged = [...state.received].sort((a, b) => a - b)
    const finalizeJob = state.finalizeJobId
      ? await prisma.job.findUnique({
          where: { id: state.finalizeJobId },
          select: { status: true, error: true },
        })
      : null
    return reply.send({
      known: true,
      staged,
      totalChunks: state.totalChunks,
      phase: getUploadPhase(state, finalizeJob?.status),
      jobId: state.finalizeJobId,
      jobStatus: finalizeJob?.status,
      jobError: finalizeJob?.error,
    })
  })

  // ── DELETE /files/upload/cancel ───────────────────────────────────────────
  app.delete("/files/upload/cancel", async (req, reply) => {
    const user = await authenticateRequest(req)
    if (!user) return reply.status(401).send("Unauthorized")

    const { uploadId } = (req.body ?? {}) as { uploadId?: string }
    if (!uploadId) return reply.status(400).send("Missing uploadId")
    if (!UPLOAD_ID_RE.test(uploadId)) return reply.status(400).send("Invalid upload id")

    // Tombstone before looking up state again: this also catches DELETE racing
    // the first chunk's async authorization/disk preflight, when no state has
    // been inserted yet.
    markUploadCancellationPending(uploadId, user.userId)
    const state = getUploadForOwner(uploadId, user.userId)
    if (!state) return reply.send({ ok: true, cleanupPending: false })

    // Lock out both new chunks and /complete before awaiting database state.
    // If finalization was already active, roll the cancellation lock back and
    // leave that atomic rename alone.
    cancelUpload(state)
    if (await uploadFinalizationIsActive(state)) {
      state.cancelled = false
      clearUploadCancellation(uploadId, user.userId)
      return reply.status(409).send("Upload finalization is in progress")
    }

    // Wait for already-started writes before scheduling deletion. Keeping the
    // cancelled state in the map until cleanup completes (or GC) prevents the
    // same id from recreating a staging file under a late delete job.
    await waitForUploadWrites(state)
    let cleanupPromise = state.cleanupPromise
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        const cleanupJobId = await publishJob(
          "fs.delete",
          { linuxUsername: state.linuxUser, path: state.tempPath, allowedRoot: state.allowedRoot },
        )
        return waitForCleanupCompletion(cleanupJobId)
      })()
      state.cleanupPromise = cleanupPromise
    }

    let cleanupCompleted: boolean
    try {
      cleanupCompleted = await cleanupPromise
    } catch (error) {
      if (state.cleanupPromise === cleanupPromise) state.cleanupPromise = undefined
      app.log.error(error, "Failed to schedule upload temp-file cleanup")
      return reply.status(502).send("Could not schedule upload cleanup")
    }

    if (cleanupCompleted) {
      deleteUploadIfSame(uploadId, state)
      clearUploadCancellation(uploadId, user.userId)
    }
    return reply.send({ ok: true, cleanupPending: !cleanupCompleted })
  })
}
