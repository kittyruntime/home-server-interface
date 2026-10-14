import { router, adminProcedure } from "../index"
import { requestSync } from "../../nats"

export interface TlsStatus {
  mode: "local" | "imported" | "proxy" | "off"
  port: number
  standardPorts: boolean
  trustedProxies: string[]
  certificate: { subject: string; issuer: string; names: string[]; notBefore: string; notAfter: string; fingerprint: string; fromAuthority: boolean } | null
  authorityFingerprint: string | null
  nginxSite: boolean
}

export const tlsRouter = router({
  status: adminProcedure.query(() => requestSync<TlsStatus>("root.tls.status", {}, 10_000)),
})
