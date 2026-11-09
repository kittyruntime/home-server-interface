import { prisma } from "@app/database"
import { announceJobEnded, consumerState } from "../nats"
import { notifyTaskEnd } from "./task-notifications"
import { log } from "../utils/log"

// A backend restart no longer fails the jobs in flight: the worker keeps
// running them and reports their end. A job is only given up once the worker
// holds no message at all (none waiting, none being worked on): then nothing
// will ever report it.

export const LOST_JOB_ERROR = "The worker no longer has this job (it was restarted)"
const RECONCILE_EVERY_MS = 60_000

export function staleJobIds(
  jobs: Array<{ id: string; createdAt: Date }>,
  consumer: { numPending: number; numAckPending: number },
  now: Date,
  graceMs = 30_000,
): string[] {
  if (consumer.numPending + consumer.numAckPending > 0) return []
  return jobs.filter(j => now.getTime() - j.createdAt.getTime() > graceMs).map(j => j.id)
}

export interface ReconcileDeps {
  unfinished(): Promise<Array<{ id: string; createdAt: Date }>>
  consumer(): Promise<{ numPending: number; numAckPending: number } | null>
  /** Fails the jobs still unfinished among ids; returns those it failed. */
  fail(ids: string[], error: string): Promise<string[]>
  /** A job ended: its waiters wake up and its owner gets a notification. */
  ended(id: string): void
}

const defaultDeps: ReconcileDeps = {
  unfinished: () => prisma.job.findMany({ where: { status: { in: ["pending", "running"] } }, select: { id: true, createdAt: true } }),
  consumer: consumerState,
  async fail(ids, error) {
    const now = new Date()
    const failed: string[] = []
    for (const id of ids) {
      const { count } = await prisma.job.updateMany({
        where: { id, status: { in: ["pending", "running"] } },
        data: { status: "failed", error, finishedAt: now },
      })
      if (count > 0) failed.push(id)
    }
    return failed
  },
  ended(id) {
    announceJobEnded(id)
    void notifyTaskEnd(id)
  },
}

export async function reconcileJobs(deps: ReconcileDeps = defaultDeps): Promise<number> {
  const jobs = await deps.unfinished()
  if (jobs.length === 0) return 0
  const consumer = await deps.consumer()
  if (!consumer) return 0
  const ids = staleJobIds(jobs, consumer, new Date())
  if (ids.length === 0) return 0
  const failed = await deps.fail(ids, LOST_JOB_ERROR)
  for (const id of failed) deps.ended(id)
  if (failed.length > 0) log.warn({ count: failed.length }, "jobs: gave up jobs the worker no longer has")
  return failed.length
}

export function startJobReconcile(): void {
  const run = () => { void reconcileJobs().catch(err => log.warn({ err }, "jobs: reconcile failed")) }
  run()
  setInterval(run, RECONCILE_EVERY_MS).unref()
}
