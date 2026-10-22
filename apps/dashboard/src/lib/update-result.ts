// Wording for the outcome of the last HSI update and the version it left behind.

export interface UpdateResult { from: string; to: string; status: string; step: string; reason: string; at: string }
export interface PreviousVersion { version: string; snapshotCreated: string }

/** The command that goes back to the previous version (the unit is hsi-worker). */
export const ROLLBACK_COMMAND = 'sudo hsi-worker update rollback'

export function lastResultText(r: UpdateResult | null): string | null {
  if (!r) return null
  const why = `at step ${r.step} (${r.reason})`
  if (r.status === 'success') return `Updated from ${r.from} to ${r.to}`
  if (r.status === 'rolled-back') return `Update to ${r.to} failed ${why}. Rolled back to ${r.from}.`
  if (r.status === 'rollback-failed') return `Update to ${r.to} failed ${why} and the rollback failed. Manual recovery is needed.`
  if (r.status === 'refused') return `Update to ${r.to} refused ${why}.`
  return null
}

/** The sentence before the rollback command, or null without a previous version. */
export function previousVersionText(previous: PreviousVersion[], formatDay: (iso: string) => string): string | null {
  const p = previous[0]
  if (!p) return null
  return `Previous version: ${p.version} (database from ${formatDay(p.snapshotCreated)}). To go back:`
}
