import { trpc } from './trpc'

// Backend mutations that dispatch work to the root-worker (fs ops, container
// actions, ...) return a jobId the instant the job is *queued* on NATS, not
// when it actually finishes: completion is recorded later, asynchronously,
// by a separate event subscriber. Callers that need the real-world effect
// to be visible (e.g. before refreshing a file listing) must poll this
// until the job leaves the pending/running state.
export async function pollJob(jobId: string, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500))
    try {
      const j = await trpc.tasks.get.query({ jobId })
      if (j.status === 'completed' || j.status === 'failed') return
    } catch {
      return
    }
  }
}

export interface JobResult {
  status: 'completed' | 'failed' | 'timeout'
  error: string | null
}

// Like `pollJob`, but reports the terminal outcome so the caller can react to
// a failure (e.g. surface a worker error like a checksum mismatch). Returns
// `'timeout'` if the job never reaches a terminal state within the deadline.
export async function pollJobResult(jobId: string, deadlineMs = 30_000): Promise<JobResult> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500))
    try {
      const j = await trpc.tasks.get.query({ jobId })
      if (j.status === 'completed') return { status: 'completed', error: null }
      if (j.status === 'failed')    return { status: 'failed', error: j.error }
    } catch (e) {
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) }
    }
  }
  return {
    status: 'timeout',
    error: `The operation did not finish within ${Math.round(deadlineMs / 1000)} s. It may still be running; refresh to check.`,
  }
}

// Error for a job that did not complete, carrying its id so the failure can
// be traced in the logs (see lib/jobLogs.ts).
export class JobError extends Error {
  readonly jobId: string
  constructor(message: string, jobId: string) {
    super(message)
    this.name = 'JobError'
    this.jobId = jobId
  }
}

// Waits for a job and throws a JobError unless it completed, so a `track`
// notification surfaces the real worker error.
export async function awaitJob(jobId: string, fallback = 'Operation failed'): Promise<void> {
  const result = await pollJobResult(jobId)
  if (result.status !== 'completed') throw new JobError(result.error ?? fallback, jobId)
}
