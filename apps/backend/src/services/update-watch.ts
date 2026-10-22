import { readFile, rm, access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { log } from "../utils/log"
import { requestSync } from "../nats"
import { dispatchEvent, type NotificationEvent } from "./notifications"

// Detects HSI updates that did not land. update.apply records the attempt next
// to the .pending-update marker; the update unit removes the marker when it
// starts the installer, which later restarts HSI and only then writes VERSION.
// So a backend started after the request waits a grace period before trusting
// VERSION, and a backend still running from before the request (download in
// progress, or an installer that died before restarting anything) waits much
// longer. Checked at boot and periodically.

export const ATTEMPT_FILE = ".update-attempt.json"
const PENDING_FILE = ".pending-update"
export const FAILURE_AFTER_MS = 15 * 60_000
export const RESTART_GRACE_MS = 5 * 60_000
export const NO_RESTART_FAILURE_AFTER_MS = 60 * 60_000
export const CHECK_EVERY_MS = 5 * 60_000

export const NOTIFIED_FILE = ".update-result-notified.json"

export interface UpdateAttempt { from: string; target: string; requestedAt: string }

export function evaluateUpdateAttempt(attempt: UpdateAttempt, current: string, pendingExists: boolean, now: Date, startedAt: Date):
  { kind: "wait" } | { kind: "succeeded" } | { kind: "failed"; event: NotificationEvent } {
  if (current === attempt.target) return { kind: "succeeded" }
  if (pendingExists) return { kind: "wait" }
  const requested = Date.parse(attempt.requestedAt)
  if (Number.isFinite(requested)) {
    const elapsed = now.getTime() - requested
    if (elapsed < FAILURE_AFTER_MS) return { kind: "wait" }
    const restartedSince = startedAt.getTime() > requested
    if (restartedSince && now.getTime() - startedAt.getTime() < RESTART_GRACE_MS) return { kind: "wait" }
    if (!restartedSince && elapsed < NO_RESTART_FAILURE_AFTER_MS) return { kind: "wait" }
  }
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
  dir: string, current: string, now: Date, dispatch: (e: NotificationEvent) => unknown, startedAt: Date,
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
  const decision = evaluateUpdateAttempt(attempt, current, pendingExists, now, startedAt)
  if (decision.kind === "wait") return "wait"
  await rm(file, { force: true })
  if (decision.kind === "failed") {
    log.warn({ target: attempt.target, current }, "update-watch: update failed")
    dispatch(decision.event)
  }
  return decision.kind
}

// Shapes of the worker's root.update.status reply. The worker's state dir is
// root-only, so the backend asks over NATS instead of reading last.json.
export interface UpdateResult { from: string; to: string; status: string; step: string; reason: string; at: string }
export interface PreviousVersion { version: string; snapshot: string; snapshotCreated: string }
export interface WorkerUpdateStatus { last: UpdateResult | null; current: string; previous: PreviousVersion[] }

export async function readWorkerUpdateStatus(): Promise<WorkerUpdateStatus | null> {
  try {
    return await requestSync<WorkerUpdateStatus>("root.update.status", {}, 5_000)
  } catch {
    return null
  }
}

const ALERTING_STATUSES: Record<string, string> = {
  "rolled-back": "rolled back",
  "rollback-failed": "rollback failed",
  "refused": "refused",
}

// Notifies a rolled-back, rollback-failed or refused update once: the `at` of
// the last notified result is kept next to the attempt record.
export async function notifyUpdateResult(
  dir: string, last: UpdateResult | null, dispatch: (e: NotificationEvent) => unknown,
): Promise<"none" | "notified"> {
  const outcome = last ? ALERTING_STATUSES[last.status] : undefined
  if (!last || !outcome || typeof last.at !== "string") return "none"
  const at = Date.parse(last.at)
  if (!Number.isFinite(at)) return "none"
  const file = join(dir, NOTIFIED_FILE)
  try {
    const notified = Date.parse((JSON.parse(await readFile(file, "utf8")) as { at?: string }).at ?? "")
    if (Number.isFinite(notified) && at <= notified) return "none"
  } catch { /* never notified, or an unreadable record: notify */ }
  dispatch({
    type: "update.failed", severity: "critical", source: "system.update", target: last.to,
    message: `Update from ${last.from} to ${last.to} ${outcome} at step ${last.step}: ${last.reason}`,
    time: new Date().toISOString(),
  })
  try {
    await writeFile(file, JSON.stringify({ at: last.at }), "utf8")
  } catch (err) {
    log.error({ err, file }, "update-watch: could not record the notified update result")
  }
  return "notified"
}

export function startUpdateWatch(opts: { dir: () => string; currentVersion: () => string }): void {
  const startedAt = new Date()
  const run = () => {
    checkUpdateAttempt(opts.dir(), opts.currentVersion(), new Date(), e => void dispatchEvent(e), startedAt)
      .catch(err => log.error({ err }, "update-watch: check failed"))
    readWorkerUpdateStatus()
      .then(status => notifyUpdateResult(opts.dir(), status?.last ?? null, e => void dispatchEvent(e)))
      .catch(err => log.error({ err }, "update-watch: result check failed"))
  }
  run()
  setInterval(run, CHECK_EVERY_MS).unref()
}
