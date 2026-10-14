import type { FastifyInstance } from "fastify"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { tlsDir } from "../services/tls-config"

// The local authority's certificate (#12): public, so a phone or a laptop can
// download it to trust HSI before anyone signs in.
export async function tlsRoutes(app: FastifyInstance) {
  app.get("/ca.crt", async (_req, reply) => {
    try {
      const pem = await readFile(join(tlsDir(), "ca.crt"))
      return reply.header("Content-Type", "application/x-x509-ca-cert")
        .header("Content-Disposition", 'attachment; filename="hsi-authority.crt"').send(pem)
    } catch {
      return reply.status(404).send({ message: "No local authority on this server" })
    }
  })
}
