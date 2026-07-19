import type { FastifyInstance } from "fastify"
import crypto from "node:crypto"
import { StringCodec } from "nats"
import { verifyToken, isTokenBlacklisted } from "../trpc/auth"
import { prisma } from "@app/database"
import { requestSync, natsSubscribe } from "../nats"

const sc = StringCodec()

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

async function canViewContainers(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } })
  return !!u?.isAdmin
}

export async function containerRoutes(app: FastifyInstance) {
  // GET /containers/:name/logs
  //
  // SSE endpoint that streams docker logs for a container.
  // Auth via Authorization: Bearer <jwt>.
  // Each SSE event is JSON: {"line":"..."} or {"done":true} on end.
  app.get("/containers/:name/logs", { config: { rateLimit: false } }, async (req, reply) => {
    const user = authFromRequest(req)
    if (!user) {
      reply.status(401).send("Unauthorized")
      return
    }

    if (!user.isAdmin && !(await canViewContainers(user.userId))) {
      reply.status(403).send("Forbidden")
      return
    }

    const { name } = req.params as { name: string }
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      reply.status(400).send("Invalid container name")
      return
    }

    const inbox = `_INBOX.logs.${crypto.randomUUID()}`

    // Subscribe before sending the request so we don't miss early lines.
    const sub = natsSubscribe(inbox)

    try {
      await requestSync("root.container.logs", { containerName: name, tail: 300, inbox }, 10_000)
    } catch (e: any) {
      sub.unsubscribe()
      reply.status(502).send(e.message ?? "Failed to start log stream")
      return
    }

    // Set SSE headers — must happen before any write.
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.setHeader("X-Accel-Buffering", "no") // disable nginx buffering
    reply.raw.flushHeaders()

    let closed = false

    req.raw.on("close", () => {
      closed = true
      sub.unsubscribe()
      requestSync("root.container.logs.stop", { inbox }, 5_000).catch(() => {})
    })

    try {
      for await (const msg of sub) {
        if (closed) break
        const text = sc.decode(msg.data)
        try {
          reply.raw.write(`data: ${text}\n\n`)
        } catch {
          break
        }
        try {
          const parsed = JSON.parse(text) as { done?: boolean }
          if (parsed.done) break
        } catch {}
      }
    } finally {
      if (!closed) reply.raw.end()
    }
  })
}
