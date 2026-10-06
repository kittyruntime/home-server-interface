// Storage descriptions (#37): wording of the drift card and the Reapply
// request. No Vue imports, so it is tested directly.

export type DriftItem = { kind: string; text: string }

export function driftTitle(items: DriftItem[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]!.text
  return `${items.length} differences from its description`
}

/**
 * The Reapply input. A stopped array with missing disks can only start
 * degraded: the review then asks to acknowledge it.
 */
export function reapplyRequest(mountPoint: string, items: DriftItem[]): { input: Record<string, unknown>; acknowledge?: string } {
  const stopped = items.some(i => i.kind === 'array-stopped')
  const missing = items.filter(i => i.kind === 'disk-missing').map(i => i.text.replace(/^Disk (.*) is not connected$/, '$1'))
  if (!stopped || missing.length === 0) return { input: { mountPoint } }
  return {
    input: { mountPoint, degraded: true },
    acknowledge: `Start the array without ${missing.join(', ')}: it has no redundancy until a disk is added`,
  }
}

/**
 * Described volumes that differ and are not on the Volumes page (array
 * stopped and fstab entry gone, for example): their drift card is shown there,
 * since they have no volume page to open.
 */
export function unlistedDrift<T extends { mountPoint: string; items: DriftItem[] }>(statuses: T[], listed: string[]): T[] {
  return statuses.filter(s => s.items.length > 0 && !listed.includes(s.mountPoint))
}
