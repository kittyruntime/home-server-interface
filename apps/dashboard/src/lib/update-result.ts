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
  if (r.status === 'success' && r.step === 'repair') return `Reinstalled ${r.to}`
  if (r.status === 'success') return `Updated from ${r.from} to ${r.to}`
  if (r.status === 'partial') return `Updated from ${r.from} to ${r.to} with skipped Compose settings. Review the items below before retrying.`
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

/** Orders vX.Y.Z like the worker: numerically, a suffixed version before the same one without. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', suffix = ''] = v.replace(/^v/, '').split(/-(.*)/s)
    return { nums: core.split('.').slice(0, 3).map(x => parseInt(x, 10) || 0), suffix }
  }
  const pa = split(a), pb = split(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (pa.suffix === pb.suffix) return 0
  if (pa.suffix === '') return 1
  if (pb.suffix === '') return -1
  return pa.suffix < pb.suffix ? -1 : 1
}

/** The sentence before the rollback command, or null when `update rollback` has nothing to go
 * back to. A target newer than current (the snapshot of an update rolled back by hand) is a
 * version to return to, not a previous one. */
export function previousVersionText(target: RollbackTarget | null, current: string, formatDay: (iso: string) => string): string | null {
  if (!target) return null
  const db = target.snapshotCreated ? `database from ${formatDay(target.snapshotCreated)}` : 'no database snapshot'
  const label = compareVersions(target.version, current) > 0 ? 'Version you can return to' : 'Previous version'
  return `${label}: ${target.version} (${db}). To go back:`
}
