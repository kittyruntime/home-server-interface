import path from "node:path"
import { fileURLToPath } from "node:url"
import Fastify from "fastify"
import cors from "@fastify/cors"
import rateLimit from "@fastify/rate-limit"
import fastifyStatic from "@fastify/static"
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify"

import { healthRoutes } from "./routes/health"
import { fileRoutes } from "./routes/files"
import { containerRoutes } from "./routes/containers"
import { appRouter } from "./trpc/routers/index"
import { createContext } from "./trpc/context"
export { connectNats, startEventSubscriber } from "./nats"

// Resolve dashboard dist: configurable via env (supports relative paths resolved from CWD),
// defaults to public/ next to server.js in the production layout.
const DASHBOARD_DIR = process.env.DASHBOARD_PATH
    ? path.resolve(process.env.DASHBOARD_PATH)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public")

export function buildApp() {
    const app = Fastify({
        logger: true,
        bodyLimit: 50 * 1024 * 1024, // 50 MB — covers 2 MB chunks with headroom
    })

    // Disable cross-origin requests — the frontend is served from the same origin.
    app.register(cors, { origin: false })

    // Global rate limit — high ceiling to accommodate chunked file uploads.
    app.register(rateLimit, { max: 2000, timeWindow: "1 minute" })

    // Stricter rate limit on the login endpoint: 20 req/min per IP.
    // Implemented via a simple in-memory sliding-window counter keyed by IP.
    const loginAttempts = new Map<string, { count: number; resetAt: number }>()
    const LOGIN_MAX  = 20
    const LOGIN_WINDOW_MS = 60_000

    app.addHook("onRequest", async (req, reply) => {
        if (!req.url.startsWith("/trpc/auth.login")) return
        const now = Date.now()
        const key = req.ip
        let entry = loginAttempts.get(key)
        if (!entry || now >= entry.resetAt) {
            entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS }
            loginAttempts.set(key, entry)
        }
        entry.count++
        if (entry.count > LOGIN_MAX) {
            reply.status(429).send({ message: "Too many login attempts. Try again later." })
        }
    })

    app.register(healthRoutes)
    app.register(fileRoutes)
    app.register(containerRoutes)

    app.register(fastifyTRPCPlugin, {
        prefix: "/trpc",
        trpcOptions: {
            router: appRouter,
            createContext,
        },
    })

    // Serve the dashboard SPA — registered last so API routes take priority.
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
