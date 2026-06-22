import { trpc } from './trpc'

// Backend mutations that dispatch work to the root-worker (fs ops, container
// actions, ...) return a jobId the instant the job is *queued* on NATS, not
// when it actually finishes — completion is recorded later, asynchronously,
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
