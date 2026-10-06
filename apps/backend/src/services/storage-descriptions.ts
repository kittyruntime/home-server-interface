import type { CheckOutcome } from "./alert-sampler"

// Storage descriptions (#37): how each volume HSI manages differs from its
// description in /etc/hsi/storage, as reported by the worker.

export type DriftItem = { kind: string; text: string }
export type DescriptionStatus = { mountPoint: string; file: string; items: DriftItem[]; description: Record<string, unknown> }

/** One warning per volume that differs from its description; every described volume is checked. */
export function descriptionFindings(list: DescriptionStatus[]): CheckOutcome {
  const found: CheckOutcome["found"] = []
  for (const s of list) {
    const [first, ...rest] = s.items
    if (!first) continue
    const more = rest.length ? ` (and ${rest.length} more)` : ""
    found.push({ target: s.mountPoint, severity: "warning", message: `${s.mountPoint} differs from its description: ${first.text}${more}` })
  }
  // The worker lists every description: one that is gone clears its alert.
  return { found, checked: list.map(s => s.mountPoint), authoritative: true }
}
