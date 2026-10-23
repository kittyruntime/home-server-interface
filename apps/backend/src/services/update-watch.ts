import { readFile, rm, access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { log } from "../utils/log"
import { requestSync, natsSubscribe } from "../nats"
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
// snapshot and snapshotCreated are null when the version has no database snapshot.
export interface PreviousVersion { version: string; snapshot: string | null; snapshotCreated: string | null }
// rollbackTarget is what `update rollback` brings back (null: nothing to go back to);
// rollbackCommand names the worker of this install.
// history: the last results, oldest first (workers before it report only last).
export interface WorkerUpdateStatus {
  last: UpdateResult | null; current: string; previous: PreviousVersion[]
  rollbackTarget?: PreviousVersion | null; rollbackCommand?: string; history?: UpdateResult[]
}

// Short timeout: update.status waits on this, and the worker may be down.
export async function readWorkerUpdateStatus(
  request: typeof requestSync = requestSync, timeoutMs = 2_000,
): Promise<WorkerUpdateStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request<WorkerUpdateStatus>("root.update.status", {}, timeoutMs),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) }),
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const ALERTING_STATUSES: Record<string, string> = {
  "rolled-back": "rolled back",
  "rollback-failed": "rollback failed",
  "refused": "refused",
}

// One result (the last.json of a worker before results.jsonl): notifyUpdateResults.
export async function notifyUpdateResult(
  dir: string, last: UpdateResult | null, dispatch: (e: NotificationEvent) => unknown,
): Promise<"none" | "notified"> {
  return (await notifyUpdateResults(dir, last ? [last] : [], dispatch)) > 0 ? "notified" : "none"
}

// Notifies, oldest first, each rolled-back (except by hand), rollback-failed or refused
// result newer than the last one handled (its `at` is kept next to the attempt record), and
// records the newest result seen: two results written between two checks are both
// notified, and each only once. Returns how many were notified.
export async function notifyUpdateResults(
  dir: string, results: UpdateResult[], dispatch: (e: NotificationEvent) => unknown,
): Promise<number> {
  const file = join(dir, NOTIFIED_FILE)
  let notified = -Infinity
  try {
    const at = Date.parse((JSON.parse(await readFile(file, "utf8")) as { at?: string }).at ?? "")
    if (Number.isFinite(at)) notified = at
  } catch { /* never notified, or an unreadable record */ }
  const fresh = results
    .filter(r => r && typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) && Date.parse(r.at) > notified)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (fresh.length === 0) return 0
  let count = 0
  for (const r of fresh) {
    const outcome = ALERTING_STATUSES[r.status]
    if (!outcome || (r.status === "rolled-back" && r.step === "manual")) continue
    dispatch({
      type: "update.failed", severity: "critical", source: "system.update", target: r.to,
      message: `Update from ${r.from} to ${r.to} ${outcome} at step ${r.step}: ${r.reason}`,
      time: new Date().toISOString(),
    })
    count++
  }
  try {
    await writeFile(file, JSON.stringify({ at: fresh[fresh.length - 1]!.at }), "utf8")
  } catch (err) {
    log.error({ err, file }, "update-watch: could not record the notified update result")
  }
  return count
}

// Checks the worker's results at boot, on each announcement the worker publishes
// after writing one (subscribe), and when called (the periodic fallback). Checks
// never overlap: one asked for while another runs follows it.
export function watchUpdateResults(opts: {
  dir: () => string
  readStatus: () => Promise<WorkerUpdateStatus | null>
  dispatch: (e: NotificationEvent) => unknown
  subscribe: (onResult: () => void) => void
}): { check: () => Promise<void>; idle: () => Promise<void> } {
  let running: Promise<void> = Promise.resolve()
  const once = async () => {
    const status = await opts.readStatus()
    if (!status) return
    const results = status.history ?? (status.last ? [status.last] : [])
    await notifyUpdateResults(opts.dir(), results, opts.dispatch)
  }
  const check = () => {
    running = running.then(once).catch(err => log.error({ err }, "update-watch: result check failed"))
    return running
  }
  opts.subscribe(() => { void check() })
  return { check, idle: () => running }
}

// The worker announces each new result on this subject (best effort).
export const UPDATE_RESULT_SUBJECT = "events.update.result"

export function startUpdateWatch(opts: { dir: () => string; currentVersion: () => string }): void {
  const startedAt = new Date()
  const results = watchUpdateResults({
    dir: opts.dir,
    readStatus: () => readWorkerUpdateStatus(),
    dispatch: e => void dispatchEvent(e),
    subscribe: onResult => {
      void (async () => {
        try {
          for await (const _msg of natsSubscribe(UPDATE_RESULT_SUBJECT)) onResult()
        } catch (err) {
          log.error({ err }, "update-watch: the result subscription ended")
        }
      })()
    },
  })
  const run = () => {
    checkUpdateAttempt(opts.dir(), opts.currentVersion(), new Date(), e => void dispatchEvent(e), startedAt)
      .catch(err => log.error({ err }, "update-watch: check failed"))
    void results.check()
  }
  run()
  setInterval(run, CHECK_EVERY_MS).unref()
}
