import path from "node:path"
import type http from "node:http"
import https from "node:https"
import { fileURLToPath } from "node:url"
import Fastify, { type FastifyServerFactory } from "fastify"
import cors from "@fastify/cors"
import rateLimit from "@fastify/rate-limit"
import fastifyStatic from "@fastify/static"
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify"

import { healthRoutes } from "./routes/health"
import { fileRoutes } from "./routes/files"
import { shareRoutes } from "./routes/share"
import { containerRoutes } from "./routes/containers"
import { backupRoutes } from "./routes/backup"
import { tlsRoutes } from "./routes/tls"
import { appRouter } from "./trpc/routers/index"
import { createContext } from "./trpc/context"
import { loggerOptions, setLogger } from "./utils/log"
export { connectNats, startEventSubscriber } from "./nats"

// Resolve dashboard dist: configurable via env (supports relative paths resolved from CWD),
// defaults to public/ next to server.js in the production layout.
const DASHBOARD_DIR = process.env.DASHBOARD_PATH
    ? path.resolve(process.env.DASHBOARD_PATH)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public")

const loopbackOnly = (address: string) =>
    address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"

// Counts the credential-guessing procedures a request calls. A tRPC batch packs
// several procedures in one path (/trpc/a,b,c?batch=1), so each entry counts.
export function sensitiveCalls(url: string): { login: number; unlock: number } {
    const out = { login: 0, unlock: 0 }
    const path = url.split("?")[0]
    if (!path.startsWith("/trpc/")) return out
    let list = path.slice("/trpc/".length)
    try { list = decodeURIComponent(list) } catch { /* keep the raw path */ }
    for (const name of list.split(",")) {
        if (name === "auth.login") out.login++
        else if (name === "shareLink.unlock") out.unlock++
    }
    return out
}

export interface BuildAppOptions {
    // Managed HTTPS (#12): serve TLS with this certificate. The server is not
    // listened on directly: startHttps hands it the TLS connections.
    https?: { cert: Buffer; key: Buffer }
    trustProxy?: (address: string) => boolean
}

export function buildApp(opts: BuildAppOptions = {}) {
    const tls = opts.https
    // The HTTPS server handles requests exactly like the default HTTP one;
    // the cast keeps the app typed as an HTTP/1 Fastify instance.
    const serverFactory: FastifyServerFactory | undefined = tls
        ? (handler) => https.createServer({ cert: tls.cert, key: tls.key }, handler) as unknown as http.Server
        : undefined
    const app = Fastify({
        logger: loggerOptions,
        bodyLimit: 50 * 1024 * 1024, // 50 MB, covers 2 MB chunks with headroom
        // tRPC batches put every procedure name in one path parameter; the
        // default of 100 characters would make long batches miss the route.
        maxParamLength: 5000,
        ...(serverFactory ? { serverFactory } : {}),
        // Trust forwarded client addresses only from loopback peers by default,
        // and in proxy mode also from the proxies listed in tls.json, so direct
        // clients cannot spoof req.ip (used by rate limiting and audit logs).
        trustProxy: opts.trustProxy ?? loopbackOnly,
    })
    setLogger(app.log)

    // Disable cross-origin requests: the frontend is served from the same origin.
    app.register(cors, { origin: false })

    // Global rate limit: high ceiling to accommodate chunked file uploads.
    app.register(rateLimit, { max: 2000, timeWindow: "1 minute" })

    // Stricter rate limit on sensitive credential-guessing endpoints: the
    // login form and the public share-link password unlock: 20 req/min per IP,
    // via a simple in-memory sliding-window counter keyed by endpoint + IP.
    const sensitiveAttempts = new Map<string, { count: number; resetAt: number }>()
    const SENSITIVE_MAX  = 20
    const SENSITIVE_WINDOW_MS = 60_000

    app.addHook("onRequest", async (req, reply) => {
        const calls = sensitiveCalls(req.url)
        const now = Date.now()
        let blocked = false
        for (const [scope, weight] of [["login", calls.login], ["unlock", calls.unlock]] as const) {
            if (weight === 0) continue
            const key = scope + ":" + req.ip
            let entry = sensitiveAttempts.get(key)
            if (!entry || now >= entry.resetAt) {
                entry = { count: 0, resetAt: now + SENSITIVE_WINDOW_MS }
                sensitiveAttempts.set(key, entry)
            }
            entry.count += weight
            if (entry.count > SENSITIVE_MAX) blocked = true
        }
        if (blocked) reply.status(429).send({ message: "Too many attempts. Try again later." })
    })

    app.register(healthRoutes)
    app.register(fileRoutes)
    app.register(shareRoutes)
    app.register(containerRoutes)
    app.register(backupRoutes)
    app.register(tlsRoutes)

    app.register(fastifyTRPCPlugin, {
        prefix: "/trpc",
        trpcOptions: {
            router: appRouter,
            createContext,
        },
    })

    // Serve the dashboard SPA, registered last so API routes take priority.
    // wildcard: true (default) registers GET /* which serves existing files and
    // calls reply.callNotFound() for missing ones, triggering the handler below.
    app.register(fastifyStatic, {
        root: DASHBOARD_DIR,
    })

    // SPA fallback: unknown routes → index.html (client-side routing)
    app.setNotFoundHandler((_req, reply) => {
        reply.sendFile("index.html")
    })

    return app
}
