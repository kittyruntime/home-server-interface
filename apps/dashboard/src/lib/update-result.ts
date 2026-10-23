// Wording for the outcome of the last HSI update and the version it left behind.

// Types come from the backend (update.status), erased at build time.
import type { trpc } from './trpc'

type UpdateStatus = Awaited<ReturnType<typeof trpc.update.status.query>>
export type UpdateResult = NonNullable<UpdateStatus['lastResult']>
export type RollbackTarget = NonNullable<UpdateStatus['rollbackTarget']>

/** The command that goes back to the previous version, as the worker names it. */
export function rollbackCommand(fromWorker: string | null | undefined): string {
  return fromWorker || 'sudo hsi-worker update rollback'
}

export function lastResultText(r: UpdateResult | null): string | null {
  if (!r) return null
  const why = `at step ${r.step} (${r.reason})`
  if (r.status === 'success') return `Updated from ${r.from} to ${r.to}`
  if (r.status === 'rolled-back' && r.step === 'manual') return `Rolled back from ${r.to} to ${r.from} by hand.`
  if (r.status === 'rolled-back') return `Update to ${r.to} failed ${why}. Rolled back to ${r.from}.`
  if (r.status === 'rollback-failed') return `Update to ${r.to} failed ${why} and the rollback failed. Manual recovery is needed.`
  if (r.status === 'refused') return `Update to ${r.to} refused ${why}.`
  return null
}

/** Whether the last result is a failure to show as such (a rollback by hand is not). */
export function lastResultIsProblem(r: UpdateResult): boolean {
  return r.status !== 'success' && !(r.status === 'rolled-back' && r.step === 'manual')
}

/** The sentence before the rollback command, or null when `update rollback` has nothing to go back to. */
export function previousVersionText(target: RollbackTarget | null, formatDay: (iso: string) => string): string | null {
  if (!target) return null
  const db = target.snapshotCreated ? `database from ${formatDay(target.snapshotCreated)}` : 'no database snapshot'
  return `Previous version: ${target.version} (${db}). To go back:`
}
