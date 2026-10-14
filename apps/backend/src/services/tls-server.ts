import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import type { Server as HttpsServer } from "node:https"
import { readFileSync, watch, type FSWatcher } from "node:fs"
import { createSecureContext } from "node:tls"
import { join } from "node:path"
import type { FastifyInstance, FastifyBaseLogger } from "fastify"
import { readTlsConfig, servesHttps, type TlsConfig } from "./tls-config"
import type { NotificationEvent } from "./notifications"

// Managed HTTPS (#12): HTTPS and a redirect share the HSI port. The first byte
// of a connection tells them apart: 0x16 opens a TLS handshake; anything else
// is plain HTTP, answered with a redirect to the same address over HTTPS.

export function redirectLocation(host: string | undefined, url: string, listenPort: number, httpsPort: number): string | null {
  if (!host) return null
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host)
  if (!m) return null
  const name = m[1]
  const port = listenPort === 80 ? httpsPort : listenPort
  return `https://${name}${port === 443 ? "" : `:${port}`}${url.startsWith("/") ? url : "/"}`
}

export function loadContext(dir: string): { cert: Buffer; key: Buffer } | null {
  try {
    const cert = readFileSync(join(dir, "server.crt"))
    const key = readFileSync(join(dir, "server.key"))
    createSecureContext({ cert, key }) // throws on a key that does not match
    return { cert, key }
  } catch {
    return null
  }
}

// The port a connection arrived on is read from its socket, so a listener
// bound to port 0 (tests) redirects to the port it actually got. With an
// explicit HTTPS port (the plain standard port), every redirect goes there.
function redirectServer(httpsPort?: number): HttpServer {
  return createHttpServer((req, res) => {
    const port = httpsPort ?? req.socket.localPort ?? 0
    const to = redirectLocation(req.headers.host, req.url ?? "/", port, port)
    if (!to) { res.writeHead(400).end("Missing Host header"); return }
    res.writeHead(308, { Location: to }).end()
  })
}

// Reads the first byte, puts it back, and hands the socket to the server that
// speaks its protocol. A peer that closes before sending anything, or sends
// nothing for idleTimeoutMs, is dropped.
function sniffer(https: HttpsServer, plain: HttpServer, idleTimeoutMs: number): NetServer {
  return createNetServer({ pauseOnConnect: true }, (socket: Socket) => {
    socket.on("error", () => socket.destroy())
    socket.setTimeout(idleTimeoutMs, () => socket.destroy())
    socket.once("readable", () => {
      const first = socket.read(1) as Buffer | null
      if (!first) { socket.destroy(); return }
      socket.unshift(first)
      socket.setTimeout(0) // the receiving server applies its own timeouts
      ;(first[0] === 0x16 ? https : plain).emit("connection", socket)
    })
  })
}

const listen = (s: NetServer, port: number) =>
  new Promise<NetServer>((resolve, reject) => {
    s.once("error", reject)
    s.listen(port, "0.0.0.0", () => { s.off("error", reject); resolve(s) })
  })

export interface StartHttpsOptions {
  // Ports used for "standard ports" (tests bind free ports instead).
  standardPortNumbers?: { https: number; http: number }
  idleTimeoutMs?: number
}

export async function startHttps(
  _app: FastifyInstance, https: HttpsServer, cfg: TlsConfig, _dir: string, log: FastifyBaseLogger, opts: StartHttpsOptions = {},
): Promise<NetServer[]> {
  const std = opts.standardPortNumbers ?? { https: 443, http: 80 }
  const idle = opts.idleTimeoutMs ?? 30_000
  // Fastify's own server never listens: connections are handed to it.
  https.requestTimeout = 0
  https.headersTimeout = 60_000
  // The HSI port is required: failing to bind it fails the start.
  const servers = [await listen(sniffer(https, redirectServer(), idle), cfg.port)]
  if (cfg.standardPorts) {
    // The standard ports are a convenience: a port taken later (by a container,
    // say) is logged and HSI keeps serving on its own port.
    const plain = redirectServer(std.https)
    const optional: [number, () => NetServer][] = [
      [std.https, () => sniffer(https, redirectServer(), idle)],
      [std.http, () => createNetServer(s => plain.emit("connection", s))],
    ]
    for (const [port, make] of optional) {
      try {
        servers.push(await listen(make(), port))
      } catch (err) {
        log.error({ err, port }, "tls: a standard port cannot be bound, HSI keeps serving on its own port")
      }
    }
  }
  return servers
}

export type Certificate = { cert: Buffer; key: Buffer }
export type CertificateLoss = "imported" | "all" | null

export interface ResolveCertificateDeps {
  dir: string
  // The port used when tls.json, read again after the worker's answer, has none.
  port: number
  request: (subject: string, data: Record<string, unknown>, timeoutMs: number) => Promise<unknown>
  log: Pick<FastifyBaseLogger, "error">
}

// The certificate tls.json asks for. When it cannot be loaded, the worker is
// asked to issue one from the local authority (for an imported certificate, it
// switches tls.json back to local); when that fails too, the caller serves
// plain HTTP (ctx null) so the admin is never locked out.
export async function resolveCertificate(cfg: TlsConfig, deps: ResolveCertificateDeps): Promise<{ cfg: TlsConfig; ctx: Certificate | null; lost: CertificateLoss }> {
  const ctx = loadContext(deps.dir)
  if (ctx) return { cfg, ctx, lost: null }
  deps.log.error("tls: the certificate cannot be loaded, asking the worker for the local authority's")
  await deps.request("root.tls.issue", { force: true }, 30_000).catch((err) => {
    deps.log.error({ err }, "tls: the worker could not issue a certificate")
  })
  const after = readTlsConfig(deps.dir, deps.port)
  const fallback = servesHttps(after) ? loadContext(deps.dir) : null
  if (!fallback) deps.log.error({ port: after.port }, "tls: no usable certificate, serving plain HTTP")
  return { cfg: after, ctx: fallback, lost: !fallback ? "all" : cfg.mode === "imported" ? "imported" : null }
}

// The alert raised when the start-up had to give up the configured certificate.
export function certificateLostEvent(lost: CertificateLoss, now: Date): NotificationEvent | null {
  if (!lost) return null
  return {
    type: "alert.raised",
    severity: "critical",
    source: "system.tls",
    target: "certificate",
    message: lost === "imported"
      ? "The imported certificate cannot be loaded: HSI switched to the local authority's certificate until it is replaced"
      : "The HTTPS certificate cannot be loaded and no replacement could be issued: HSI serves plain HTTP. Run sudo hsi-worker tls reset.",
    time: now.toISOString(),
  }
}

export function watchCertificate(server: Pick<HttpsServer, "setSecureContext">, dir: string, log: Pick<FastifyBaseLogger, "error" | "info">, debounceMs = 500): FSWatcher {
  let timer: NodeJS.Timeout | null = null
  const watcher = watch(dir, (_event, file) => {
    if (file !== "server.crt" && file !== "server.key") return
    if (timer) clearTimeout(timer)
    // Both files change in one plan: reload once, after the last write.
    timer = setTimeout(() => {
      const ctx = loadContext(dir)
      if (!ctx) { log.error("tls: the new certificate cannot be loaded, the current one stays"); return }
      server.setSecureContext(ctx)
      log.info("tls: certificate reloaded")
    }, debounceMs)
    timer.unref()
  })
  watcher.on("error", (err) => log.error({ err }, "tls: certificate watch failed"))
  return watcher
}
