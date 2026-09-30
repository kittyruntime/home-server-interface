import { pathUnder } from "./volume-guard"

// Volumes (#40): where the data lives. A volume is a data filesystem (on a
// partition, an array, a logical volume or a whole disk, outside the system
// disk), or an HSI volume missing at boot (#3). Built from what the worker
// reports; no I/O here.

export type VDev = {
  name: string
  type: string
  fstype: string
  mountpoint: string
  label?: string
  uuid: string
  size: number
  model: string
  serial?: string
  isSystem: boolean
  usage?: string
  owner?: string
  usageTotal: number
  usageUsed: number
  usageFree: number
  children?: VDev[]
}

export type VolumeInput = {
  devices: VDev[]
  raids: Array<{ name: string; level: string; state: string; active: number; total: number; resyncPercent?: number | null; syncAction?: string }>
  lvm: {
    pvs: Array<{ name: string; vgName: string }>
    vgs: Array<{ name: string }>
    lvs: Array<{ name: string; vgName: string }>
  }
  guard: Array<{ mountPoint: string; uuid: string; state: string }>
  holds: Array<{ mountPoint: string; reason: string; status: string }>
  places: Array<{ id: string; name: string; path: string }>
  shares: Array<{ placeId: string; name: string }>
  apps: Array<{ name: string; sources: string[] }>
}

export type Redundancy = "none" | "raid0" | "raid1" | "raid5" | "raid6" | "raid10"
export type VolumeIssue = { kind: "degraded" | "rebuilding" | "missing" | "blocked" | "nearly-full"; text: string }
export type StackLayer = { kind: "filesystem" | "partition" | "lv" | "vg" | "array" | "disk"; name: string }

export type Volume = {
  id: string
  name: string
  state: "mounted" | "not-mounted" | "missing"
  device?: string
  fstype?: string
  mountPoint?: string
  redundancy: Redundancy
  tolerates: number
  stack: StackLayer[]
  disks: Array<{ name: string; serial?: string; model: string }>
  space?: { total: number; used: number; free: number }
  issues: VolumeIssue[]
  usedBy: { places: Array<{ id: string; name: string }>; shares: string[]; apps: string[] }
}

export type VolumeOverview = {
  volumes: Volume[]
  freeDisks: Array<{ name: string; size: number; model: string; serial?: string }>
  system?: { mountPoint: "/"; free: number; total: number }
}

const NOT_FILESYSTEMS = new Set(["", "linux_raid_member", "LVM2_member", "swap"])
const NEARLY_FULL = 0.9

// Device-mapper name of an LV: dashes in the VG and LV names are doubled.
const dmName = (vg: string, lv: string) => `${vg.replace(/-/g, "--")}-${lv.replace(/-/g, "--")}`
const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p

function levelOf(level: string): Redundancy {
  return (["raid0", "raid1", "raid5", "raid6", "raid10"] as const).find(l => l === level) ?? "none"
}

function tolerance(level: Redundancy, members: number): number {
  switch (level) {
    case "raid1":  return Math.max(0, members - 1)
    case "raid5":  return 1
    case "raid6":  return 2
    case "raid10": return 1
    default:       return 0
  }
}

export function buildVolumes(input: VolumeInput): VolumeOverview {
  // lsblk repeats an array or an LV under each of its members: index nodes by
  // name and keep every parent seen.
  const nodes = new Map<string, VDev>()
  const parents = new Map<string, Set<string>>()
  const system = new Set<string>()
  function walk(dev: VDev, parent: VDev | null, inSystem: boolean) {
    if (!nodes.has(dev.name)) nodes.set(dev.name, dev)
    if (parent) {
      if (!parents.has(dev.name)) parents.set(dev.name, new Set())
      parents.get(dev.name)!.add(parent.name)
    }
    const sys = inSystem || dev.isSystem
    if (sys) system.add(dev.name)
    for (const c of dev.children ?? []) walk(c, dev, sys)
  }
  for (const d of input.devices) walk(d, null, false)

  const raids = new Map(input.raids.map(r => [r.name, r]))
  const lvByDm = new Map(input.lvm.lvs.map(lv => [dmName(lv.vgName, lv.name), lv]))

  function ancestors(name: string): VDev[] {
    const seen = new Set<string>()
    const out: VDev[] = []
    const queue = [...(parents.get(name) ?? [])]
    while (queue.length) {
      const n = queue.shift()!
      if (seen.has(n)) continue
      seen.add(n)
      const node = nodes.get(n)
      if (node) out.push(node)
      queue.push(...(parents.get(n) ?? []))
    }
    return out
  }

  // Redundancy of one PV or filesystem device: its array's level, or none.
  function redundancyOf(devName: string): { level: Redundancy; tolerates: number } {
    const chain = [nodes.get(devName), ...ancestors(devName)].filter((d): d is VDev => !!d)
    const array = chain.find(d => raids.has(d.name))
    if (!array) return { level: "none", tolerates: 0 }
    const r = raids.get(array.name)!
    const level = levelOf(r.level)
    return { level, tolerates: tolerance(level, r.total) }
  }

  const guardByUuid = new Map(input.guard.map(g => [g.uuid, g]))
  const guardByMount = new Map(input.guard.map(g => [g.mountPoint, g]))

  const volumes: Volume[] = []
  for (const dev of nodes.values()) {
    if (NOT_FILESYSTEMS.has(dev.fstype) || system.has(dev.name) || dev.type === "rom") continue

    const up = ancestors(dev.name)
    const lv = dev.type === "lvm" ? lvByDm.get(dev.name) : undefined
    const arrays = [dev, ...up].filter(d => raids.has(d.name)).map(d => d.name)
    const partitions = up.filter(d => d.type === "part").map(d => d.name)
    const disks = [dev, ...up].filter(d => d.type === "disk")
    const sorted = (xs: string[]) => [...new Set(xs)].sort()

    const stack: StackLayer[] = [{ kind: "filesystem", name: dev.mountpoint || dev.name }]
    if (lv) stack.push({ kind: "lv", name: lv.name }, { kind: "vg", name: lv.vgName })
    for (const a of sorted(arrays)) stack.push({ kind: "array", name: a })
    for (const p of sorted(partitions)) stack.push({ kind: "partition", name: p })
    for (const d of sorted(disks.map(d => d.name))) stack.push({ kind: "disk", name: d })

    // A VG is as redundant as its weakest PV.
    let red = redundancyOf(dev.name)
    if (lv) {
      const pvs = input.lvm.pvs.filter(p => p.vgName === lv.vgName).map(p => redundancyOf(basename(p.name)))
      if (pvs.length) red = pvs.reduce((a, b) => (b.tolerates < a.tolerates ? b : a))
    }

    const issues: VolumeIssue[] = []
    for (const a of sorted(arrays)) {
      const r = raids.get(a)!
      if (r.active < r.total) issues.push({ kind: "degraded", text: `${a} is missing ${r.total - r.active} of ${r.total} disks` })
      if (r.syncAction && ["recovery", "resync", "reshape"].includes(r.syncAction) && r.resyncPercent != null)
        issues.push({ kind: "rebuilding", text: `${a} is rebuilding (${Math.round(r.resyncPercent)}%)` })
    }
    const guard = (dev.uuid && guardByUuid.get(dev.uuid)) || (dev.mountpoint ? guardByMount.get(dev.mountpoint) : undefined)
    if (guard?.state === "missing") issues.push({ kind: "missing", text: "Not found at boot" })
    else if (guard && (guard.state === "wrong" || guard.state === "readonly"))
      issues.push({ kind: "blocked", text: guard.state === "readonly" ? "Mounted read-only" : "Another device is mounted there" })
    const hold = dev.mountpoint ? input.holds.find(h => h.mountPoint === dev.mountpoint && h.status === "blocked") : undefined
    if (hold && !issues.some(i => i.kind === "blocked" || i.kind === "missing")) issues.push({ kind: "blocked", text: hold.reason })

    const mounted = !!dev.mountpoint
    const space = mounted && dev.usageTotal > 0 ? { total: dev.usageTotal, used: dev.usageUsed, free: dev.usageFree } : undefined
    if (space && space.used / space.total > NEARLY_FULL)
      issues.push({ kind: "nearly-full", text: `${Math.round((space.used / space.total) * 100)}% full` })

    volumes.push({
      id: dev.uuid || `dev:${dev.name}`,
      name: dev.label || lv?.name || (dev.mountpoint ? basename(dev.mountpoint) : "") || dev.name,
      state: mounted ? "mounted" : "not-mounted",
      device: dev.name,
      fstype: dev.fstype,
      mountPoint: dev.mountpoint || undefined,
      redundancy: red.level,
      tolerates: red.tolerates,
      stack,
      disks: [...new Map(disks.map(d => [d.name, { name: d.name, serial: d.serial, model: d.model }])).values()]
        .sort((a, b) => a.name.localeCompare(b.name)),
      space,
      issues,
      usedBy: { places: [], shares: [], apps: [] },
    })
  }

  // HSI volumes missing at boot (#3): known by their mount point only.
  const uuids = new Set(volumes.map(v => v.id))
  for (const g of input.guard) {
    if (g.state !== "missing" || uuids.has(g.uuid) || volumes.some(v => v.mountPoint === g.mountPoint)) continue
    volumes.push({
      id: `missing:${g.mountPoint}`, name: basename(g.mountPoint), state: "missing", mountPoint: g.mountPoint,
      redundancy: "none", tolerates: 0, stack: [], disks: [],
      issues: [{ kind: "missing", text: "Not found at boot" }],
      usedBy: { places: [], shares: [], apps: [] },
    })
  }

  // What uses each volume: the most specific mount point holding the path.
  const holder = (path: string) => volumes
    .filter(v => v.mountPoint && pathUnder(path, v.mountPoint))
    .sort((a, b) => b.mountPoint!.length - a.mountPoint!.length)[0]
  for (const p of input.places) {
    const v = holder(p.path)
    if (!v) continue
    v.usedBy.places.push({ id: p.id, name: p.name })
    for (const s of input.shares.filter(s => s.placeId === p.id)) v.usedBy.shares.push(s.name)
  }
  for (const app of input.apps) {
    const hit = new Set(app.sources.map(holder).filter((v): v is Volume => !!v))
    for (const v of hit) v.usedBy.apps.push(app.name)
  }

  const rank = (v: Volume) => (v.state === "missing" ? 0 : v.issues.length ? 1 : 2)
  volumes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

  const freeDisks = input.devices
    .filter(d => d.type === "disk" && d.usage === "free" && !d.isSystem)
    .map(d => ({ name: d.name, size: d.size, model: d.model, serial: d.serial }))

  const root = [...nodes.values()].find(d => d.mountpoint === "/")
  return {
    volumes,
    freeDisks,
    system: root ? { mountPoint: "/", free: root.usageFree, total: root.usageTotal } : undefined,
  }
}
