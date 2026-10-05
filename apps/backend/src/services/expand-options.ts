import type { CheckOutcome } from "./alert-sampler"

// Expand a volume (#7): which ways a volume can grow, from what the Volumes
// page already reads. The worker checks everything again when the plan is
// built: this only decides what to offer.

export type ExpandMode = "vgFree" | "addDisk" | "raidAddDisk" | "mirrorGrow"
export type ExpandOption = { mode: ExpandMode; gain: number; disks?: Array<{ name: string; size: number }> }

type Dev = { name: string; size: number; children?: Dev[] }
type ExpandVolume = { id: string; state: string; fstype?: string; stack: Array<{ kind: string; name: string }> }
export type PendingExpansion = { uuid: string; lv?: string; mountpoint?: string; phase: string; error?: string; newSize?: number; announced?: boolean }
export type ExpandInput = {
  lvm: {
    pvs: Array<{ name: string; vgName: string; size?: number }>
    vgs: Array<{ name: string; free?: number }>
    lvs: Array<{ name: string; vgName: string; path?: string }>
  }
  raids: Array<{ name: string; level: string; active: number; total: number; syncAction?: string; resyncPercent?: number | null; members?: Array<{ name: string; role: string }> }>
  devices: Dev[]
  freeDisks: Array<{ name: string; size: number }>
  expansions: PendingExpansion[]
}

const GROWABLE = new Set(["ext4", "xfs", "btrfs"])
// A member keeps a few MiB for its superblock: below this, nothing to gain.
const MIN_GAIN = 256 * 1024 * 1024

function findDev(list: Dev[], name: string): Dev | undefined {
  for (const d of list) {
    if (d.name === name) return d
    const c = findDev(d.children ?? [], name)
    if (c) return c
  }
  return undefined
}

export function expandOptions(v: ExpandVolume, input: ExpandInput): { options: ExpandOption[]; reason?: string } {
  const none = (reason: string) => ({ options: [], reason })
  if (v.state === "missing") return none("The volume is missing")
  if (!v.fstype || !GROWABLE.has(v.fstype)) return none(`Growing a ${v.fstype || "volume without a"} filesystem is not supported (ext4, XFS and btrfs are)`)
  if (v.fstype !== "ext4" && v.state !== "mounted") return none(`An ${v.fstype.toUpperCase()} filesystem grows only while mounted: mount it first`)
  if (input.expansions.some(e => e.uuid === v.id && e.phase !== "done")) return none("An expansion of this volume is already under way")
  const vgName = v.stack.find(l => l.kind === "vg")?.name
  if (!v.stack.some(l => l.kind === "lv") || !vgName) return none("Only volumes on LVM can be expanded")

  const options: ExpandOption[] = []
  const vgFree = input.lvm.vgs.find(g => g.name === vgName)?.free ?? 0
  const pvs = input.lvm.pvs.filter(p => p.vgName === vgName)
  const arrayName = pvs.length === 1 ? pvs[0]!.name.replace(/^\/dev\//, "") : undefined
  const raid = arrayName ? input.raids.find(r => r.name === arrayName) : undefined

  if (raid) {
    if (raid.active < raid.total) return none(`/dev/${raid.name} is degraded: replace its failed disk first`)
    if (raid.syncAction && raid.syncAction !== "idle") return none(`/dev/${raid.name} is busy (${raid.syncAction}): expand it once that is over`)
  }
  if (vgFree > MIN_GAIN) options.push({ mode: "vgFree", gain: vgFree })

  if (raid) {
    const members = (raid.members ?? []).filter(m => m.role === "active").map(m => findDev(input.devices, m.name)?.size ?? 0)
    const smallest = members.length ? Math.min(...members) : 0
    if (raid.level === "raid5" || raid.level === "raid6") {
      const disks = input.freeDisks.filter(d => d.size >= smallest)
      if (smallest > 0 && disks.length) options.push({ mode: "raidAddDisk", gain: smallest, disks })
    } else if (raid.level === "raid1" || raid.level === "raid10") {
      const arraySize = findDev(input.devices, raid.name)?.size ?? 0
      const n = members.length
      // raid1: each member holds the array; raid10 (near 2): half of it each.
      const component = raid.level === "raid1" ? arraySize : (arraySize * 2) / Math.max(n, 1)
      const copies = raid.level === "raid1" ? 1 : n / 2
      const gain = (smallest - component) * copies
      if (smallest > 0 && gain > MIN_GAIN) options.push({ mode: "mirrorGrow", gain })
    }
  } else if (input.freeDisks.length) {
    const disks = input.freeDisks
    options.push({ mode: "addDisk", gain: Math.max(...disks.map(d => d.size)), disks })
  }
  if (!options.length) return none(raid ? "No free disk that can join the array, and no free space in the volume group" : "No free disk, and no free space in the volume group")
  return { options }
}

function fmtSize(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let i = 0
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++ }
  return `${n.toFixed(1)} ${units[i]}`
}

/** Alerts for finished expansions: done is announced once (then acked), failed warns until retried. */
export function expansionFindings(list: PendingExpansion[]): CheckOutcome & { ack: string[] } {
  const found: CheckOutcome["found"] = []
  const ack: string[] = []
  for (const e of list) {
    const target = e.mountpoint || e.lv || e.uuid
    if (e.phase === "done" && !e.announced) {
      found.push({ target, message: `The volume at ${target} now has ${fmtSize(e.newSize ?? 0)}`, severity: "info" })
      ack.push(e.uuid)
    } else if (e.phase === "failed") {
      found.push({ target, message: `Expanding the volume at ${target} failed: ${e.error ?? "unknown error"}`, severity: "warning" })
    }
  }
  return { found, checked: list.map(e => e.mountpoint || e.lv || e.uuid), ack }
}
