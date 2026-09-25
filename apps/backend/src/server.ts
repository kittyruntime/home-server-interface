import { buildApp, connectNats, startEventSubscriber } from "./app"
import { startMetricsSampler } from "./services/metrics-sampler"
import { startAlertSampler } from "./services/alert-sampler"
import { startTelemetry } from "./services/telemetry"
import { startBackupScheduler } from "./services/backup-scheduler"
import { ensureDefaultRule } from "./services/notifications"
import { log } from "./utils/log"

// Crashes go through the logger too, so the log file stays one JSON line per event.
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception")
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "unhandled promise rejection")
})

const app = buildApp()

function backendPort(): number {
  const raw = process.env.BACKEND_PORT ?? "9001"
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid BACKEND_PORT: ${raw}`)
  }
  return port
}

const start = async () => {
  try {
    if (process.env.HSI_SMOKE_TEST === "1") {
      await app.ready()
      await app.close()
      return
    }

    const port = backendPort()
    await connectNats()
    startMetricsSampler()
    startAlertSampler()
    await ensureDefaultRule()
    startTelemetry(app.log)
    startBackupScheduler()
    void startEventSubscriber(app.log).catch(err => {
      app.log.error(err, "nats: event subscriber fatal error")
      process.exit(1)
    })

    await app.listen({ port, host: "0.0.0.0" })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
