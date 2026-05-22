import { connect, StringCodec, NatsError } from "nats"
import type { NatsConnection, JetStreamClient, JetStreamManager } from "nats"
import type { FastifyBaseLogger } from "fastify"
import { prisma } from "@brume/database"
import crypto from "node:crypto"

const sc = StringCodec()

let nc: NatsConnection
let js: JetStreamClient

// ── Stream definition ─────────────────────────────────────────────────────────

const TASK_STREAM = {
  name: "TASKS",
  subjects: [
    "root.fs.mkdir",
    "root.fs.copy",
    "root.fs.move",
    "root.fs.rename",
    "root.fs.delete",
    "root.fs.assemble",
    "root.fs.chmod",
    "root.fs.chown",
    "root.container.create",
    "root.container.recreate",
    "root.container.start",
    "root.container.stop",
    "root.container.restart",
    "root.container.remove",
    "root.container.inspect",
    "root.container.listAll",
    "root.network.create",
    "root.network.remove",
    "root.volume.create",
    "root.volume.remove",
  ],
}

// ── Connect ───────────────────────────────────────────────────────────────────

export async function connectNats(): Promise<void> {
  const servers = process.env.NATS_URL ?? "nats://127.0.0.1:4222"
  const user    = process.env.NATS_USER ?? "backend"
  const pass    = process.env.NATS_PASS ?? "backend-dev"

  // Retry the initial connection for up to 60 s.  systemd's After= guarantees
  // nats is *started* before us, but not necessarily ready yet.
  const deadline = Date.now() + 60_000
  while (true) {
    try {
      nc = await connect({ servers, user, pass })
      break
    } catch (e: any) {
      if (Date.now() >= deadline) throw e
      await new Promise<void>(r => setTimeout(r, 2_000))
    }
  }
  js = nc.jetstream()

  // Ensure the task stream exists (idempotent — worker does the same).
  const jsm: JetStreamManager = await nc.jetstreamManager()
  try {
    await jsm.streams.add(TASK_STREAM as any)
  } catch (e: any) {
    if (e instanceof NatsError && e.message.includes("stream name already in use")) {
      await jsm.streams.update("TASKS", TASK_STREAM as any)
    } else {
      throw e
    }
  }

  // Mark any jobs that were pending/running before this process started as failed.
  // (They will never receive their result event since the server restarted.)
  await prisma.job.updateMany({
    where: { status: { in: ["pending", "running"] } },
    data:  { status: "failed", error: "Server restarted before job completed" },
  })
}

// ── Health ────────────────────────────────────────────────────────────────────

export function isNatsConnected(): boolean {
  return !!nc && !nc.isClosed() && !nc.isDraining()
}

// ── Publish async job ─────────────────────────────────────────────────────────

export async function publishJob(
  action:  string,
  payload: Record<string, unknown>,
  userId?: string,
): Promise<string> {
  const jobId = crypto.randomUUID()

  await prisma.job.create({
    data: { id: jobId, status: "pending", action, userId },
  })

  const subject = `root.${action}`
  await js.publish(subject, sc.encode(JSON.stringify({ jobId, ...payload })))

  return jobId
}

// ── Sync request-reply ────────────────────────────────────────────────────────

type WorkerResponse<T> =
  | { ok: true;  result: T }
  | { ok: false; error: string; code?: string }

export async function requestSync<T>(
  subject: string,
  payload: Record<string, unknown>,
  timeout = 10_000,
): Promise<T> {
  const msg = await nc.request(subject, sc.encode(JSON.stringify(payload)), { timeout })
  let resp: WorkerResponse<T>
  try {
    resp = JSON.parse(sc.decode(msg.data)) as WorkerResponse<T>
  } catch {
    throw new Error("Invalid worker response")
  }
  if (!resp.ok) {
    throw Object.assign(new Error(resp.error), { code: resp.code })
  }
  return resp.result
}

// Download uses binary reply — worker sends raw bytes, not JSON.
export async function requestRead(
  path: string,
  linuxUsername: string,
  timeout = 30_000,
): Promise<Buffer> {
  const msg = await nc.request(
    "root.fs.read",
    sc.encode(JSON.stringify({ path, linuxUsername })),
    { timeout },
  )
  return Buffer.from(msg.data)
}

// Write a chunk directly into destDir via the worker (no /tmp involved).
// Binary chunk data is sent as the raw message body; metadata goes in a header.
export async function writeChunk(opts: {
  uploadId:      string
  chunkIndex:    number
  destDir:       string
  linuxUsername: string
  data:          Buffer
}, timeout = 30_000): Promise<void> {
  const { headers } = await import("nats")
  const h = headers()
  h.set("X-Meta", JSON.stringify({
    uploadId:      opts.uploadId,
    chunkIndex:    opts.chunkIndex,
    destDir:       opts.destDir,
    linuxUsername: opts.linuxUsername,
  }))
  const msg = await nc.request(
    "root.fs.write-chunk",
    opts.data,
    { headers: h, timeout },
  )
  let resp: { ok: boolean; error?: string; code?: string }
  try {
    resp = JSON.parse(sc.decode(msg.data)) as { ok: boolean; error?: string; code?: string }
  } catch {
    throw new Error("Invalid worker response")
  }
  if (!resp.ok) {
    throw Object.assign(new Error(resp.error ?? "write-chunk failed"), { code: resp.code })
  }
}

// ── Event subscriber ──────────────────────────────────────────────────────────

type JobEvent = {
  jobId:   string
  status:  "completed" | "failed"
  result?: unknown
  error?:  string
}

export async function startEventSubscriber(log: FastifyBaseLogger): Promise<void> {
  const sub = nc.subscribe("events.job.*")

  for await (const msg of sub) {
    try {
      let event: JobEvent
      try {
        event = JSON.parse(sc.decode(msg.data)) as JobEvent
      } catch {
        log.warn("nats: event subscriber received invalid JSON, skipping message")
        continue
      }
      if (!event.jobId) {
        log.warn("nats: event subscriber received message without jobId, skipping")
        continue
      }
      await prisma.job.update({
        where: { id: event.jobId },
        data: {
          status: event.status,
          result: event.result != null ? JSON.stringify(event.result) : null,
          error:  event.error  ?? null,
        },
      })
    } catch (e) {
      log.error(e, "nats: event subscriber error")
    }
  }
}
