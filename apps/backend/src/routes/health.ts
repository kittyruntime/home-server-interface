import type { FastifyInstance, FastifyRequest } from "fastify"
import { prisma } from "@app/database"
import { isNatsConnected } from "../nats"
import { HSI_VERSION } from "../version"

const DB_TIMEOUT_MS = 2_000

// A cheap round trip to the database; a hung or failing query reads as down.
export async function checkDatabase(query: () => Promise<unknown>, timeoutMs = DB_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      query(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs) }),
    ])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// /health is public: concurrent calls share one in-flight probe and its result
// is kept for a short while, so a stuck database cannot pile up queries.
export function shareProbe(probe: () => Promise<boolean>, ttlMs: number): () => Promise<boolean> {
  let inflight: Promise<boolean> | null = null
  let cached: { value: boolean; at: number } | null = null
  return () => {
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.value)
    inflight ??= probe().then(value => {
      cached = { value, at: Date.now() }
      return value
    }).finally(() => { inflight = null })
    return inflight
  }
}

export interface HealthProbes { nats: () => boolean; db: () => Promise<boolean> }

const defaultProbes: HealthProbes = {
  nats: isNatsConnected,
  db: shareProbe(() => checkDatabase(() => prisma.$queryRaw`SELECT 1`), DB_TIMEOUT_MS),
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

// A direct loopback caller (the update gate runs on the host): the socket peer, not
// req.ip, and no forwarding header, so a request a local proxy forwards does not count.
export function isLocalCaller(req: FastifyRequest): boolean {
  const h = req.headers
  return LOOPBACK.has(req.socket.remoteAddress ?? "") && !h["x-forwarded-for"] && !h["x-real-ip"] && !h.forwarded
}

// The update health gate (root-worker) reads this exact shape: 200 only when
// NATS and the database both answer, and the running version is reported. The
// version and the database state go to local callers only; others get the status.
export async function healthRoutes(app: FastifyInstance, opts: Partial<HealthProbes> = {}) {
  const probes = { ...defaultProbes, ...opts }
  app.get("/health", async (req, reply) => {
    const nats = probes.nats()
    const db = await probes.db()
    const healthy = nats && db
    const status = healthy ? "ok" : "degraded"
    return reply.status(healthy ? 200 : 503)
      .send(isLocalCaller(req) ? { status, nats, db, version: HSI_VERSION } : { status, nats })
  })
}
