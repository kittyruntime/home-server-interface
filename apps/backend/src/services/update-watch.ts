import { readFile, rm, access } from "node:fs/promises"
import { join } from "node:path"
import { log } from "../utils/log"
import { dispatchEvent, type NotificationEvent } from "./notifications"

// Detects HSI updates that did not land. update.apply records the attempt next
// to the .pending-update marker; the update unit removes the marker when it
// starts the installer. If, well after that, HSI still runs another version,
// the update failed (the installer rolled back or never finished). Checked at
// boot and periodically: a failure before the services stopped never restarts
// the backend.

export const ATTEMPT_FILE = ".update-attempt.json"
const PENDING_FILE = ".pending-update"
export const FAILURE_AFTER_MS = 15 * 60_000
export const CHECK_EVERY_MS = 5 * 60_000

export interface UpdateAttempt { from: string; target: string; requestedAt: string }

export function evaluateUpdateAttempt(attempt: UpdateAttempt, current: string, pendingExists: boolean, now: Date):
  { kind: "wait" } | { kind: "succeeded" } | { kind: "failed"; event: NotificationEvent } {
  if (current === attempt.target) return { kind: "succeeded" }
  if (pendingExists) return { kind: "wait" }
  const requested = Date.parse(attempt.requestedAt)
  if (Number.isFinite(requested) && now.getTime() - requested < FAILURE_AFTER_MS) return { kind: "wait" }
  return {
    kind: "failed",
    event: {
      type: "update.failed", severity: "critical", source: "system.update", target: attempt.target,
      message: `Update to ${attempt.target} failed, still running ${current}`, time: now.toISOString(),
    },
  }
}

function isAttempt(v: unknown): v is UpdateAttempt {
  const a = v as UpdateAttempt
  return !!a && typeof a.from === "string" && typeof a.target === "string" && typeof a.requestedAt === "string"
}

export async function checkUpdateAttempt(
  dir: string, current: string, now: Date, dispatch: (e: NotificationEvent) => unknown,
): Promise<"none" | "wait" | "succeeded" | "failed" | "corrupt"> {
  const file = join(dir, ATTEMPT_FILE)
  let raw: string
  try {
    raw = await readFile(file, "utf8")
  } catch {
    return "none"
  }
  let attempt: unknown
  try {
    attempt = JSON.parse(raw)
  } catch {
    attempt = null
  }
  if (!isAttempt(attempt)) {
    await rm(file, { force: true })
    log.warn({ file }, "update-watch: unreadable update attempt record removed")
    return "corrupt"
  }
  const pendingExists = await access(join(dir, PENDING_FILE)).then(() => true, () => false)
  const decision = evaluateUpdateAttempt(attempt, current, pendingExists, now)
  if (decision.kind === "wait") return "wait"
  await rm(file, { force: true })
  if (decision.kind === "failed") {
    log.warn({ target: attempt.target, current }, "update-watch: update failed")
    dispatch(decision.event)
  }
  return decision.kind
}

export function startUpdateWatch(opts: { dir: () => string; currentVersion: () => string }): void {
  const run = () => {
    checkUpdateAttempt(opts.dir(), opts.currentVersion(), new Date(), e => void dispatchEvent(e))
      .catch(err => log.error({ err }, "update-watch: check failed"))
  }
  run()
  setInterval(run, CHECK_EVERY_MS).unref()
}
