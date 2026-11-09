import type { BackupStatus } from "./backup-status"
import type { UpdateAttempt } from "./update-watch"
import { decodeJobMeta, type JobKind, type JobMeta } from "./job-meta"

// What the Activity panel lists: the viewer's background jobs, other users'
// for an administrator, and what the system itself runs (backups, updates).

/** Near-instant jobs: listing them would only flicker. */
export const HIDDEN_ACTIONS = ["fs.mkdir", "fs.touch", "fs.rename", "fs.chmod", "fs.chown"]
export const HISTORY_DAYS = 7
export const HISTORY_PAGE = 50
/** File jobs the worker can stop part-way and clean up after. */
export const CANCELLABLE_ACTIONS = ["fs.copy", "fs.move", "fs.zip", "fs.unzip"]

export type TaskKind = JobKind | "backup" | "update"
/** username is null once the account was deleted. */
export type TaskOwner = "me" | "system" | { userId: string; username: string | null }

export interface TaskView {
  id: string
  kind: TaskKind
  status: "queued" | "running"
  meta: JobMeta
  owner: TaskOwner
  createdAt: string
  startedAt: string | null
  percent: number | null
  /** The viewer may cancel it (their own copy, move, zip or unzip). */
  cancellable: boolean
}

export interface TaskHistoryView extends Omit<TaskView, "status" | "percent" | "cancellable"> {
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
  return { userId, username: usernames.get(userId) ?? null }
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

/** Only the owner cancels a task, administrators included: it is their work. */
export function canCancel(job: { userId: string | null; action: string; status: string }, viewerId: string): boolean {
  return !!job.userId && job.userId === viewerId && CANCELLABLE_ACTIONS.includes(job.action)
    && (job.status === "pending" || job.status === "running")
}

export function toTaskView(job: JobRow, viewerId: string, usernames: Map<string, string>): TaskView {
  return {
    ...base(job, viewerId, usernames),
    status: job.status === "running" ? "running" : "queued",
    percent: null,
    cancellable: !job.cancelledAt && canCancel(job, viewerId),
  }
}

export function toHistoryView(job: JobRow, viewerId: string, usernames: Map<string, string>): TaskHistoryView {
  // A cancel only counts when the job did stop: one asked too late (an instant
  // rename, the last chunk) still ends completed.
  const status = job.status === "completed" ? "completed" : job.cancelledAt ? "cancelled" : "failed"
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
      cancellable: false,
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
      cancellable: false,
    })
  }
  return out
}

/**
 * A system task as a non-admin may see it: its kind and timing, not what it
 * works on nor its error (backup plans and app details are admin only).
 */
export function redactSystem<T extends { owner: TaskOwner; meta: JobMeta; error?: string | null }>(view: T, isAdmin: boolean): T {
  if (isAdmin || view.owner !== "system") return view
  const out = { ...view, meta: { kind: view.meta.kind } }
  if ("error" in view) out.error = null
  return out
}
