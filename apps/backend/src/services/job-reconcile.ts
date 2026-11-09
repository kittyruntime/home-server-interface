import { prisma } from "@app/database"
import { consumerState } from "../nats"
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

export async function reconcileJobs(): Promise<number> {
  const jobs = await prisma.job.findMany({
    where: { status: { in: ["pending", "running"] } },
    select: { id: true, createdAt: true },
  })
  if (jobs.length === 0) return 0
  const consumer = await consumerState()
  if (!consumer) return 0
  const now = new Date()
  const ids = staleJobIds(jobs, consumer, now)
  if (ids.length === 0) return 0
  const { count } = await prisma.job.updateMany({
    where: { id: { in: ids }, status: { in: ["pending", "running"] } },
    data: { status: "failed", error: LOST_JOB_ERROR, finishedAt: now },
  })
  if (count > 0) log.warn({ count }, "jobs: gave up jobs the worker no longer has")
  return count
}

export function startJobReconcile(): void {
  const run = () => { void reconcileJobs().catch(err => log.warn({ err }, "jobs: reconcile failed")) }
  run()
  setInterval(run, RECONCILE_EVERY_MS).unref()
}
