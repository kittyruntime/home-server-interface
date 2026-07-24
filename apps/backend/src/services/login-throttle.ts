import { TRPCError } from "@trpc/server"

// Fixed-window throttle for failed login attempts, keyed per username and per
// client IP. In-memory on purpose: a restart clears it, the same tradeoff the
// token blacklist already makes.

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 5

interface Entry {
  failures: number
  windowStart: number
}

const attempts = new Map<string, Entry>()

function liveEntry(key: string, now: number): Entry | undefined {
  const entry = attempts.get(key)
  if (!entry) return undefined
  if (now - entry.windowStart >= WINDOW_MS) {
    attempts.delete(key)
    return undefined
  }
  return entry
}

/** Throws TOO_MANY_REQUESTS if any key has exhausted its failure budget. */
export function assertNotThrottled(keys: string[]): void {
  const now = Date.now()
  for (const key of keys) {
    const entry = liveEntry(key, now)
    if (entry && entry.failures >= MAX_FAILURES) {
      const retryAfterSec = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000)
      const wait = retryAfterSec >= 120
        ? `${Math.ceil(retryAfterSec / 60)} minutes`
        : `${retryAfterSec} seconds`
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Too many failed login attempts — try again in ${wait}`,
      })
    }
  }
}

export function recordLoginFailure(keys: string[]): void {
  const now = Date.now()
  for (const key of keys) {
    const entry = liveEntry(key, now)
    if (entry) {
      entry.failures += 1
    } else {
      attempts.set(key, { failures: 1, windowStart: now })
    }
  }
}

export function clearLoginFailures(keys: string[]): void {
  for (const key of keys) attempts.delete(key)
}

// Sweep expired windows so the map doesn't accumulate one entry per
// username/IP ever tried.
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of attempts) {
    if (now - entry.windowStart >= WINDOW_MS) attempts.delete(key)
  }
}, WINDOW_MS).unref()
