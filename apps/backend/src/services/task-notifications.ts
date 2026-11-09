import { prisma } from "@app/database"
import { decodeJobMeta } from "./job-meta"
import { recordInApp } from "./notifications"
import { log } from "../utils/log"

// When a background task ends, the user who started it gets a notification:
// "Copy finished" or "Copy failed" with the reason, opening the folder. It is
// theirs only, and stays in the app (no webhook or e-mail: those are for
// system alerts).

/** Tasks worth a notification: the long ones a user starts and walks away from. */
export const NOTIFY_ACTIONS = [
  "fs.copy", "fs.move", "fs.delete", "fs.zip", "fs.unzip",
  "container.composeUp", "container.composeStop", "container.composeRestart", "container.composeDown",
]

export interface TaskNotification {
  userId: string
  eventType: "task.completed" | "task.failed"
  severity: "info" | "warning"
  source: string
  target: string
  message: string
  link: string | null
}

const last = (path?: string) => (path ? path.replace(/\/+$/, "").split("/").pop() || path : undefined)
const parentOf = (path: string) => {
  const i = path.lastIndexOf("/")
  return i <= 0 ? "/" : path.slice(0, i)
}

export function taskNotification(job: {
  userId: string | null; action: string; status: string; error: string | null; meta: string | null; cancelledAt: Date | null
}): TaskNotification | null {
  if (!job.userId || job.cancelledAt || !NOTIFY_ACTIONS.includes(job.action)) return null
  if (job.status !== "completed" && job.status !== "failed") return null
  const meta = decodeJobMeta(job.meta, job.action)
  if (meta.internal) return null
  const link = meta.kind === "container" ? null
    : meta.kind === "delete" ? (meta.src ? parentOf(meta.src) : null)
    : meta.dst ?? null
  const failed = job.status === "failed"
  return {
    userId: job.userId,
    eventType: failed ? "task.failed" : "task.completed",
    severity: failed ? "warning" : "info",
    source: job.action,
    target: meta.kind === "container" ? meta.name ?? "" : last(meta.kind === "delete" ? meta.src : meta.dst ?? meta.name) ?? "",
    message: failed ? job.error ?? "" : "",
    link,
  }
}

/** Notifications a user sees: global alerts and their own task results. */
export function notificationWhere(user: { userId: string }) {
  return { OR: [{ userId: null }, { userId: user.userId }] }
}

export async function notifyTaskEnd(jobId: string): Promise<void> {
  try {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { userId: true, action: true, status: true, error: true, meta: true, cancelledAt: true },
    })
    const row = job && taskNotification(job)
    if (row) await recordInApp(row)
  } catch (err) {
    log.warn({ err, jobId }, "notifications: could not record a task result")
  }
}
