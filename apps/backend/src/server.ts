import { buildApp, connectNats, startEventSubscriber } from "./app"
import { startMetricsSampler } from "./services/metrics-sampler"
import { startAlertSampler } from "./services/alert-sampler"
import { startVolumeGuard } from "./services/volume-guard"
import { syncSharesBestEffort } from "./services/sharing.service"
import { startTelemetry } from "./services/telemetry"
import { migrateRsyncPlans } from "./services/backup-status"
import { startTlsWatch } from "./services/tls-watch"
import { dispatchEvent, ensureDefaultRule } from "./services/notifications"
import { migrateNotificationStorage } from "./services/notification-connectors"
import { startDeliveryQueue } from "./services/notification-queue"
import { startUpdateWatch } from "./services/update-watch"
import { updateStateDir, readCurrentVersion } from "./trpc/routers/update"
import { log } from "./utils/log"
import type { Server as HttpsServer } from "node:https"
import { requestSync } from "./nats"
import { prisma } from "@app/database"
import { readTlsConfig, servesHttps, trustProxyFn, tlsDir } from "./services/tls-config"
import { certificateLostEvent, resolveCertificate, startHttps, watchCertificate, type Certificate, type CertificateLoss } from "./services/tls-server"

// Crashes go through the logger too, so the log file stays one JSON line per event.
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception")
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "unhandled promise rejection")
})

function backendPort(): number {
  const raw = process.env.BACKEND_PORT ?? "9001"
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid BACKEND_PORT: ${raw}`)
  }
  return port
}

const start = async () => {
  if (process.env.HSI_SMOKE_TEST === "1") {
    const app = buildApp()
    try {
      await app.ready()
      // Loads the SQLite driver, a native module the bundle must leave external.
      await prisma.$queryRaw`SELECT 1`
      await app.close()
    } catch (err) {
      app.log.error(err)
      process.exit(1)
    }
    return
  }

  try {
    let tlsCfg = readTlsConfig(tlsDir(), backendPort())
    await connectNats()
    let ctx: Certificate | null = null
    let lost: CertificateLoss = null
    if (servesHttps(tlsCfg)) {
      ;({ cfg: tlsCfg, ctx, lost } = await resolveCertificate(tlsCfg, { dir: tlsDir(), port: backendPort(), request: requestSync, log }))
    }
    const app = buildApp({ https: ctx ?? undefined, trustProxy: trustProxyFn(tlsCfg) })

    startMetricsSampler()
    startAlertSampler()
    startVolumeGuard()
    // Shares and Place access follow the database, which a configuration
    // restore replaces just before this restart: nothing else writes them out
    // until some sharing setting changes (#1).
    void syncSharesBestEffort(prisma)
    await migrateNotificationStorage()
    await ensureDefaultRule()
    await startDeliveryQueue()
    const lostEvent = certificateLostEvent(lost, new Date())
    if (lostEvent) void dispatchEvent(lostEvent)
    startUpdateWatch({ dir: updateStateDir, currentVersion: readCurrentVersion })
    startTelemetry(app.log)
    void migrateRsyncPlans()
    startTlsWatch()
    void startEventSubscriber(app.log).catch(err => {
      app.log.error(err, "nats: event subscriber fatal error")
      process.exit(1)
    })

    if (ctx) {
      await app.ready()
      const server = app.server as unknown as HttpsServer
      await startHttps(app, server, tlsCfg, tlsDir(), app.log)
      watchCertificate(server, tlsDir(), app.log)
      app.log.info({ port: tlsCfg.port, standardPorts: tlsCfg.standardPorts }, "tls: serving HTTPS")
    } else {
      await app.listen({ port: tlsCfg.port, host: "0.0.0.0" })
    }
  } catch (err) {
    log.error({ err }, "backend failed to start")
    process.exit(1)
  }
}

start()
