import type { FastifyInstance } from "fastify"
import { createReadStream, createWriteStream } from "node:fs"
import { access, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { prisma } from "@app/database"
import {
  countRestoredDatabase, createEncryptedConfigBackup, restoreBusy, setRestoreBusy, stagingRoot, swapDatabase, validateRestoredDatabase,
} from "../services/config-backup"
import { applyConfigRestore, cancelConfigRestore, previewConfigRestore, purgeStaging, restoreCaller, sweepRestores, type RestoreDeps } from "../services/config-restore"
import { verifySetupSession } from "../trpc/auth"
import { requestSync } from "../nats"
import { readCurrentVersion } from "../trpc/routers/update"
import { authenticateRequest } from "../utils/request-auth"

const MAX_BACKUP_SIZE = 256 * 1024 * 1024

const restoreDeps: RestoreDeps = {
  stagingRoot,
  worker: (subject, payload) => requestSync(subject, payload, 300_000),
  validateDb: validateRestoredDatabase,
  countRestored: countRestoredDatabase,
  pathExists: p => access(p).then(() => true, () => false),
  currentVersion: readCurrentVersion,
  currentSecretsKey: () => process.env.HSI_SECRETS_KEY?.trim(),
  envPath: () => path.join(process.env.INSTALL_DIR ?? process.cwd(), ".env"),
  swapDatabase,
  now: () => Date.now(),
}

async function authenticatedAdmin(request: { headers: { authorization?: string } }) {
  const user = await authenticateRequest(request)
  return user?.isAdmin ? user.userId : null
}

// Restoring is open to an admin, or to the first-run assistant (#12) with its
// setup session while no administrator exists (checked on every call).
async function restoreAuth(request: { headers: { authorization?: string } }) {
  const user = await authenticateRequest(request)
  let setupSession = false
  const auth = request.headers.authorization
  if (!user && auth?.startsWith("Bearer ")) {
    try { verifySetupSession(auth.slice(7)); setupSession = true } catch { /* not a setup session */ }
  }
  const adminCount = setupSession ? await prisma.user.count({ where: { isAdmin: true } }) : 1
  return restoreCaller({ adminUserId: user?.isAdmin ? user.userId : null, setupSession, adminCount })
}

export async function backupRoutes(app: FastifyInstance) {
  // Decrypted previews never outlive 15 minutes, and none survives a restart.
  const sweep = setInterval(() => { void sweepRestores(restoreDeps) }, 60_000)
  sweep.unref()
  setTimeout(() => { void stagingRoot().then(purgeStaging).catch(() => {}) }, 5_000).unref()

  app.addContentTypeParser("application/vnd.hsi.config-backup", (_request, payload, done) => done(null, payload))

  app.post("/system/config-backup", {
    bodyLimit: 4 * 1024,
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
  }, async (request, reply) => {
    const userId = await authenticatedAdmin(request)
    if (!userId) return reply.status(403).send({ error: "Forbidden" })
    const password = (request.body as { password?: unknown } | null)?.password
    if (typeof password !== "string" || password.length < 16 || password.length > 1024) {
      return reply.status(400).send({ error: "Password must contain between 16 and 1024 characters" })
    }

    let success = false
    try {
      const backup = await createEncryptedConfigBackup(password, readCurrentVersion())
      const stream = createReadStream(backup.path)
      stream.once("close", () => { void backup.cleanup() })
      stream.once("error", () => { void backup.cleanup() })
      reply.header("Content-Type", "application/octet-stream")
      reply.header("Content-Disposition", `attachment; filename="${backup.filename}"`)
      reply.header("Cache-Control", "no-store")
      reply.header("X-Content-Type-Options", "nosniff")
      success = true
      return reply.send(stream)
    } finally {
      await prisma.auditLog.create({ data: { userId, action: "system.configBackup", ip: request.ip, success } }).catch(() => {})
    }
  })

  // Restore, step 1 (#1): upload the backup and its password, get a preview.
  app.post("/system/config-restore/preview", {
    bodyLimit: MAX_BACKUP_SIZE,
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
  }, async (request, reply) => {
    if (!await restoreAuth(request)) return reply.status(403).send({ error: "Forbidden" })
    if (restoreBusy()) return reply.status(409).send({ error: "A configuration restore is in progress" })
    if (request.headers["content-type"]?.split(";", 1)[0] !== "application/vnd.hsi.config-backup") {
      return reply.status(415).send({ error: "Unsupported backup content type" })
    }
    const encodedPassword = request.headers["x-hsi-backup-password"]
    if (typeof encodedPassword !== "string" || encodedPassword.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedPassword)) {
      return reply.status(400).send({ error: "Missing backup password" })
    }
    const password = Buffer.from(encodedPassword, "base64").toString("utf8")
    if (password.length < 16 || password.length > 1024) return reply.status(400).send({ error: "Invalid backup password" })

    const dir = await mkdtemp(path.join(os.tmpdir(), "hsi-config-upload-"))
    const uploaded = path.join(dir, "upload.hsibak")
    let bytes = 0
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > MAX_BACKUP_SIZE ? new Error("Backup exceeds 256 MiB") : null, chunk)
      },
    })
    try {
      await pipeline(request.body as Readable, limiter, createWriteStream(uploaded, { flags: "wx", mode: 0o600 }))
      if (bytes === 0) return reply.status(400).send({ error: "Backup file is empty" })
      reply.header("Cache-Control", "no-store")
      return await previewConfigRestore(uploaded, password, restoreDeps)
    } catch (error) {
      request.log.warn({ err: error }, "configuration backup rejected")
      return reply.status(400).send({ error: (error as Error).message })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Restore: forget a preview (Cancel), with its decrypted files.
  app.post("/system/config-restore/cancel", { bodyLimit: 4 * 1024 }, async (request, reply) => {
    if (!await restoreAuth(request)) return reply.status(403).send({ error: "Forbidden" })
    const token = (request.body as { token?: unknown } | null)?.token
    if (typeof token === "string" && token.length <= 64) await cancelConfigRestore(token)
    return { ok: true }
  })

  // Restore, step 2: apply a preview, then restart.
  app.post("/system/config-restore/apply", {
    bodyLimit: 4 * 1024,
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
  }, async (request, reply) => {
    const caller = await restoreAuth(request)
    if (!caller) return reply.status(403).send({ error: "Forbidden" })
    const token = (request.body as { token?: unknown } | null)?.token
    if (typeof token !== "string" || token.length > 64) return reply.status(400).send({ error: "Missing restore token" })
    if (restoreBusy()) return reply.status(409).send({ error: "A configuration restore is in progress" })
    setRestoreBusy(true)
    try {
      await applyConfigRestore(token, caller.userId, request.ip, restoreDeps)
      // Restored from the first-run assistant: its accounts are back, so the
      // one-time setup link must not open anything any more.
      if (caller.setup) await requestSync("root.setup.consume", {}, 10_000).catch(() => {})
      reply.header("Cache-Control", "no-store")
      // Stop accepting requests before exit so Prisma cannot reconnect to the
      // freshly swapped database during the short response/restart window.
      const timer = setTimeout(() => {
        const hardStop = setTimeout(() => process.exit(75), 2_000)
        hardStop.unref()
        void app.close().finally(() => process.exit(75))
      }, 250)
      timer.unref()
      return { ok: true }
    } catch (error) {
      setRestoreBusy(false)
      request.log.warn({ err: error }, "configuration restore rejected")
      return reply.status(400).send({ error: (error as Error).message })
    }
  })
}
