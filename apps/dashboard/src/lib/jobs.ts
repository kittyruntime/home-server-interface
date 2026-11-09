import { tr } from './tr.ts'
import { trpc } from './trpc'

export interface JobResult {
  status: 'completed' | 'failed' | 'timeout'
  error: string | null
  failureSource?: 'task' | 'observer'
}

export interface JobObservation {
  status: 'pending' | 'running' | 'completed' | 'failed'
  action: string
}

// Backend mutations that dispatch work to the root-worker (fs ops, container
// actions, ...) return a jobId the instant the job is *queued* on NATS, not
// when it actually finishes. This polls until the job leaves the
// pending/running state and reports the terminal outcome so the caller can
// react to a failure (e.g. surface a worker error like a checksum mismatch). Returns
// `'timeout'` if the job never reaches a terminal state within the deadline.
// Most jobs (a new folder, a rename) end within a few hundred milliseconds:
// the first checks come quickly, then every 1.5 s for the long ones.
const POLL_DELAYS_MS = [100, 250, 500, 1000]
export function pollDelay(attempt: number): number {
  return POLL_DELAYS_MS[attempt] ?? 1500
}

export async function pollJobResult(
  jobId: string,
  deadlineMs = 30_000,
  observe?: (job: JobObservation) => void,
  signal?: AbortSignal,
): Promise<JobResult> {
  const deadline = Date.now() + deadlineMs
  let attempt = 0
  while (Date.now() < deadline && !signal?.aborted) {
    const delay = pollDelay(attempt++)
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, delay)
      function done() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    })
    if (signal?.aborted) break
    try {
      const j = await trpc.tasks.get.query({ jobId })
      observe?.({ status: j.status, action: j.action })
      if (j.status === 'completed') return { status: 'completed', error: null }
      if (j.status === 'failed')    return { status: 'failed', error: j.error, failureSource: 'task' }
    } catch (e) {
      return { status: 'failed', error: e instanceof Error ? e.message : String(e), failureSource: 'observer' }
    }
  }
  return {
    status: 'timeout',
    error: tr('lib.jobs.theOperationDidNotFinish', `The operation did not finish within ${Math.round(deadlineMs / 1000)} s. It may still be running; refresh to check.`, { p0: Math.round(deadlineMs / 1000) }),
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
export async function awaitJob(jobId: string, fallback = tr('lib.jobs.operationFailed', 'Operation failed')): Promise<void> {
  const result = await pollJobResult(jobId)
  if (result.status !== 'completed') throw new JobError(result.error ?? fallback, jobId)
}
