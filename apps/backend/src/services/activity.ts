import type { BackupStatus } from "./backup-status"
import type { UpdateAttempt } from "./update-watch"
import { decodeJobMeta, type JobKind, type JobMeta } from "./job-meta"

// What the Activity panel lists: the viewer's background jobs, other users'
// for an administrator, and what the system itself runs (backups, updates).

/** Near-instant jobs: listing them would only flicker. */
export const HIDDEN_ACTIONS = ["fs.mkdir", "fs.touch", "fs.rename", "fs.chmod", "fs.chown"]
export const HISTORY_DAYS = 7
export const HISTORY_PAGE = 50

export type TaskKind = JobKind | "backup" | "update"
export type TaskOwner = "me" | "system" | { userId: string; username: string }

export interface TaskView {
  id: string
  kind: TaskKind
  status: "queued" | "running"
  meta: JobMeta
  owner: TaskOwner
  createdAt: string
  startedAt: string | null
  percent: number | null
}

export interface TaskHistoryView extends Omit<TaskView, "status" | "percent"> {
  status: "completed" | "failed" | "cancelled"
  finishedAt: string | null
  error: string | null
}

export interface JobRow {
  id: string
  status: string
  action: string
  userId: string | null
  meta: string | null
  error: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  cancelledAt: Date | null
}

export function jobWhere(user: { userId: string; isAdmin: boolean }) {
  return user.isAdmin ? {} : { OR: [{ userId: user.userId }, { userId: null }] }
}

export function isListed(job: { action: string; meta: string | null }): boolean {
  if (HIDDEN_ACTIONS.includes(job.action)) return false
  return !decodeJobMeta(job.meta, job.action).internal
}

function ownerOf(userId: string | null, viewerId: string, usernames: Map<string, string>): TaskOwner {
  if (!userId) return "system"
  if (userId === viewerId) return "me"
  return { userId, username: usernames.get(userId) ?? "?" }
}

function base(job: JobRow, viewerId: string, usernames: Map<string, string>) {
  const meta = decodeJobMeta(job.meta, job.action)
  delete meta.internal
  return {
    id: job.id,
    kind: meta.kind as TaskKind,
    meta,
    owner: ownerOf(job.userId, viewerId, usernames),
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
  }
}

export function toTaskView(job: JobRow, viewerId: string, usernames: Map<string, string>): TaskView {
  return { ...base(job, viewerId, usernames), status: job.status === "running" ? "running" : "queued", percent: null }
}

export function toHistoryView(job: JobRow, viewerId: string, usernames: Map<string, string>): TaskHistoryView {
  const status = job.cancelledAt ? "cancelled" : job.status === "completed" ? "completed" : "failed"
  return { ...base(job, viewerId, usernames), status, finishedAt: job.finishedAt?.toISOString() ?? null, error: job.error }
}

export function systemTasks(backup: Pick<BackupStatus, "plans"> | null, attempt: UpdateAttempt | null): TaskView[] {
  const out: TaskView[] = []
  for (const plan of backup?.plans ?? []) {
    if (plan.last?.status !== "running") continue
    const pct = plan.progress?.percentDone
    out.push({
      id: `backup:${plan.id}`,
      kind: "backup",
      status: "running",
      meta: { kind: "other", name: plan.name },
      owner: "system",
      createdAt: plan.last.start,
      startedAt: plan.last.start,
      percent: typeof pct === "number" ? Math.round(pct * 100) : null,
    })
  }
  if (attempt) {
    out.push({
      id: `update:${attempt.target}`,
      kind: "update",
      status: "running",
      meta: { kind: "other", name: attempt.target },
      owner: "system",
      createdAt: attempt.requestedAt,
      startedAt: attempt.requestedAt,
      percent: null,
    })
  }
  return out
}
