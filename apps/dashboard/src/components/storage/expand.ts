// Expand a volume (#7): labels for the options and for an expansion under
// way. No Vue imports, so it is tested directly.

export type ExpandMode = 'vgFree' | 'addDisk' | 'raidAddDisk' | 'mirrorGrow'

const LABEL: Record<ExpandMode, string> = {
  vgFree: 'Use the free space of the volume group',
  addDisk: 'Add a disk to the volume',
  raidAddDisk: 'Add a disk to the RAID array',
  mirrorGrow: 'Use the larger disks of the mirror',
}

// Same units as fmtBytes in store.ts (powers of 1024).
function size(n: number): string {
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`
  return `${(n / 1024 ** 4).toFixed(2)} TB`
}

export function optionLabel(mode: ExpandMode, gain: number): string {
  return `${LABEL[mode]} (+${size(gain)})`
}

/** The line a volume page shows while an expansion is pending. */
export function expansionLine(e: { phase: string; error?: string }, reshapePercent: number | null): string {
  if (e.phase === 'failed') return `Expansion failed: ${e.error ?? 'unknown error'}`
  if (e.phase !== 'reshape') return ''
  return reshapePercent != null
    ? `Expanding: reshape ${Math.round(reshapePercent)}%, then the filesystem`
    : 'Expanding: the filesystem grows once the array is ready'
}

/** Erasing a disk, or rewriting a whole array: these need a backup. */
export const needsBackup = (mode: ExpandMode) => mode === 'raidAddDisk' || mode === 'mirrorGrow'
export const erasesADisk = (mode: ExpandMode) => mode === 'raidAddDisk' || mode === 'addDisk'
