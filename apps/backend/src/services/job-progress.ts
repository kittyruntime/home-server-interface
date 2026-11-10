// The worker reports a copy's, zip's or unzip's bytes once a second. They stay
// in memory (no database write per second): the task list turns them into a
// percent and, once the rate is known, the time left.

export interface ProgressSample { done: number; total: number }
export interface ProgressView { percent: number; remainingSec: number | null }

/** Seconds of samples needed before the time left means something. */
const MIN_RATE_WINDOW_MS = 3_000

export function createProgressBook() {
  const jobs = new Map<string, { first: ProgressSample & { at: number }; last: ProgressSample & { at: number } }>()
  return {
    record(jobId: string, s: ProgressSample, at = Date.now()) {
      const prev = jobs.get(jobId)
      const point = { ...s, at }
      jobs.set(jobId, { first: prev?.first ?? point, last: point })
    },
    forget(jobId: string) {
      jobs.delete(jobId)
    },
    view(jobId: string, now = Date.now()): ProgressView | null {
      const j = jobs.get(jobId)
      if (!j) return null
      const { first, last } = j
      const percent = last.total > 0 ? Math.min(100, Math.floor((last.done / last.total) * 100)) : 0
      const elapsed = last.at - first.at
      const rate = elapsed >= MIN_RATE_WINDOW_MS ? (last.done - first.done) / (elapsed / 1000) : 0
      const remainingSec = rate > 0 && last.total > 0 && now - last.at < 60_000
        ? Math.max(0, Math.round((last.total - last.done) / rate))
        : null
      return { percent, remainingSec }
    },
  }
}

export const jobProgress = createProgressBook()
