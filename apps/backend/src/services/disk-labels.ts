import { TRPCError } from "@trpc/server"

// Names the admin gives physical disks, stored by serial (#32).

export const DISK_LABEL_MAX = 40

/** The label to store, or null to remove it. */
export function normalizeDiskLabel(raw: string): string | null {
  const label = raw.trim()
  if (!label) return null
  if (label.length > DISK_LABEL_MAX)
    throw new TRPCError({ code: "BAD_REQUEST", message: `A disk label is at most ${DISK_LABEL_MAX} characters` })
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(label))
    throw new TRPCError({ code: "BAD_REQUEST", message: "A disk label cannot contain control characters" })
  return label
}
