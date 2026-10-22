import { FastifyInstance } from "fastify"
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

export interface HealthProbes { nats: () => boolean; db: () => Promise<boolean> }

const defaultProbes: HealthProbes = {
  nats: isNatsConnected,
  db: () => checkDatabase(() => prisma.$queryRaw`SELECT 1`),
}

// The update health gate (root-worker) reads this exact shape: 200 only when
// NATS and the database both answer, and the running version is reported.
export async function healthRoutes(app: FastifyInstance, opts: Partial<HealthProbes> = {}) {
  const probes = { ...defaultProbes, ...opts }
  app.get("/health", async (_req, reply) => {
    const nats = probes.nats()
    const db = await probes.db()
    const healthy = nats && db
    return reply.status(healthy ? 200 : 503).send({ status: healthy ? "ok" : "degraded", nats, db, version: HSI_VERSION })
  })
}
