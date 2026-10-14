import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import type { Server as HttpsServer } from "node:https"
import { readFileSync, watch, type FSWatcher } from "node:fs"
import { createSecureContext } from "node:tls"
import { join } from "node:path"
import type { FastifyInstance, FastifyBaseLogger } from "fastify"
import type { TlsConfig } from "./tls-config"

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
// bound to port 0 (tests) redirects to the port it actually got. Without an
// explicit HTTPS port, HTTPS is served on that same port.
function redirectServer(httpsPort?: number): HttpServer {
  return createHttpServer((req, res) => {
    const listenPort = req.socket.localPort ?? 0
    const to = redirectLocation(req.headers.host, req.url ?? "/", listenPort, httpsPort ?? listenPort)
    if (!to) { res.writeHead(400).end("Missing Host header"); return }
    res.writeHead(308, { Location: to }).end()
  })
}

// Reads the first byte, puts it back, and hands the socket to the server that
// speaks its protocol. A peer that closes before sending anything is dropped.
function sniffer(https: HttpsServer, plain: HttpServer): NetServer {
  return createNetServer({ pauseOnConnect: true }, (socket: Socket) => {
    socket.on("error", () => socket.destroy())
    socket.once("readable", () => {
      const first = socket.read(1) as Buffer | null
      if (!first) { socket.destroy(); return }
      socket.unshift(first)
      ;(first[0] === 0x16 ? https : plain).emit("connection", socket)
    })
  })
}

const listen = (s: NetServer, port: number) =>
  new Promise<NetServer>((resolve, reject) => {
    s.once("error", reject)
    s.listen(port, "0.0.0.0", () => { s.off("error", reject); resolve(s) })
  })

export async function startHttps(_app: FastifyInstance, https: HttpsServer, cfg: TlsConfig, _dir: string, _log: FastifyBaseLogger): Promise<NetServer[]> {
  // Fastify's own server never listens: connections are handed to it.
  https.requestTimeout = 0
  https.headersTimeout = 60_000
  const servers = [await listen(sniffer(https, redirectServer()), cfg.port)]
  if (cfg.standardPorts) {
    servers.push(await listen(sniffer(https, redirectServer()), 443))
    const plain80 = redirectServer(443)
    servers.push(await listen(createNetServer(s => plain80.emit("connection", s)), 80))
  }
  return servers
}

export function watchCertificate(server: HttpsServer, dir: string, log: FastifyBaseLogger): FSWatcher {
  let timer: NodeJS.Timeout | null = null
  return watch(dir, (_event, file) => {
    if (file !== "server.crt" && file !== "server.key") return
    if (timer) clearTimeout(timer)
    // Both files change in one plan: reload once, after the last write.
    timer = setTimeout(() => {
      const ctx = loadContext(dir)
      if (!ctx) { log.error("tls: the new certificate cannot be loaded, the current one stays"); return }
      server.setSecureContext(ctx)
      log.info("tls: certificate reloaded")
    }, 500)
  })
}
