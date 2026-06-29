import * as os from "os"
import * as fs from "fs"
import { z } from "zod"
import { router, protectedProcedure, adminProcedure } from "../index"
import { requestSync } from "../../nats"

// --- CPU delta ---
let cpuPrev: { idle: number; total: number }[] | null = null

function cpuPercent(): number {
  const cpus = os.cpus()
  const current = cpus.map(c => {
    const t = Object.values(c.times).reduce((a, b) => a + b, 0)
    return { idle: c.times.idle, total: t }
  })

  if (!cpuPrev) {
    cpuPrev = current
    return 0
  }

  let idleDelta = 0
  let totalDelta = 0
  for (let i = 0; i < current.length; i++) {
    idleDelta  += current[i]!.idle  - (cpuPrev[i]?.idle  ?? 0)
    totalDelta += current[i]!.total - (cpuPrev[i]?.total ?? 0)
  }
  cpuPrev = current

  if (totalDelta === 0) return 0
  const used = totalDelta - idleDelta
  return Math.min(100, Math.max(0, Math.round((used / totalDelta) * 100)))
}

// --- Network delta (/proc/net/dev) ---
let netPrev: Record<string, { rx: number; tx: number }> | null = null
let netPrevMs = 0

function parseNetDev(): Record<string, { rx: number; tx: number }> {
  try {
    const content = fs.readFileSync("/proc/net/dev", "utf8")
    const result: Record<string, { rx: number; tx: number }> = {}
    for (const line of content.split("\n").slice(2)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [iface, rest] = trimmed.split(":")
      if (!iface || !rest) continue
      const cols = rest.trim().split(/\s+/)
      result[iface.trim()] = {
        rx: parseInt(cols[0] ?? "0", 10),
        tx: parseInt(cols[8] ?? "0", 10),
      }
    }
    return result
  } catch {
    return {}
  }
}

function netRates(): { rx: number; tx: number } {
  const now = Date.now()
  const current = parseNetDev()

  if (!netPrev || Object.keys(netPrev).length === 0) {
    netPrev  = current
    netPrevMs = now
    return { rx: 0, tx: 0 }
  }

  const dt = (now - netPrevMs) / 1000
  if (dt <= 0) return { rx: 0, tx: 0 }

  let rxDelta = 0
  let txDelta = 0
  for (const [iface, vals] of Object.entries(current)) {
    if (iface === "lo") continue
    const prev = netPrev[iface]
    if (!prev) continue
    rxDelta += Math.max(0, vals.rx - prev.rx)
    txDelta += Math.max(0, vals.tx - prev.tx)
  }

  netPrev  = current
  netPrevMs = now

  return {
    rx: Math.round(rxDelta / dt),
    tx: Math.round(txDelta / dt),
  }
}

// --- Memory ---
function memoryInfo(): { total: number; used: number; percent: number } {
  const total = os.totalmem()
  const free  = os.freemem()
  const used  = total - free
  return {
    total,
    used,
    percent: Math.round((used / total) * 100),
  }
}

// --- Static system info ---
function sysinfoSnapshot() {
  const cpus = os.cpus()
  const rawIfaces = os.networkInterfaces()
  const ifaces = Object.entries(rawIfaces)
    .map(([name, addrs]) => ({
      name,
      addrs: (addrs ?? [])
        .filter(a => a.family === "IPv4" || a.family === "IPv6")
        .map(a => ({ addr: a.address, family: a.family as string })),
    }))
    .filter(i => i.addrs.length > 0)
    .sort((a, b) => (a.name === "lo" ? 1 : b.name === "lo" ? -1 : a.name.localeCompare(b.name)))
  return {
    hostname: os.hostname(),
    platform: os.platform() as string,
    arch:     os.arch() as string,
    release:  os.release(),
    cpuModel: cpus[0]?.model?.replace(/\s+/g, " ").trim() ?? "Unknown",
    cpuCount: cpus.length,
    loadavg:  os.loadavg() as [number, number, number],
    ifaces,
  }
}

// --- Router ---
export const systemRouter = router({
  metrics: protectedProcedure.query(() => {
    return {
      cpu:     cpuPercent(),
      memory:  memoryInfo(),
      network: netRates(),
      uptime:  Math.floor(os.uptime()),
    }
  }),

  sysinfo: adminProcedure.query(() => sysinfoSnapshot()),

  disks: adminProcedure.query(async () => {
    return await requestSync<{
      disks: Array<{ device: string; mountPoint: string; fsType: string; total: number; used: number; free: number }>
      raids: Array<{ name: string; level: string; state: string; devices: string[]; active: number; total: number }>
    }>("root.sys.disks", {})
  }),

  blockDevices: adminProcedure.query(async () => {
    return await requestSync<{
      devices: unknown[]
      raids: Array<{ name: string; level: string; state: string; devices: string[]; active: number; total: number }>
    }>("root.sys.blockdevices", {}, 15_000)
  }),

  formatDisk: adminProcedure
    .input(z.object({
      // Bare name (sda1, md0) or relative LVM path (ubuntu-vg/ubuntu-lv)
      device: z.string().regex(/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?$/),
      fstype: z.enum(['ext4', 'xfs', 'btrfs', 'fat32']),
      label:  z.string().max(64).optional(),
    }))
    .mutation(async ({ input }) => {
      return await requestSync("root.sys.format", input, 120_000)
    }),

  mountDevice: adminProcedure
    .input(z.object({
      device:     z.string().regex(/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?$/),
      // Disallow whitespace and # to prevent fstab field injection
      mountpoint: z.string().min(2).max(255).regex(/^\/[^\s#]+$/, 'Invalid mount point'),
      options:    z.string().max(255).regex(/^[^\n\r\t]*$/, 'Invalid mount options').optional(),
      persist:    z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      return await requestSync("root.sys.mount", input, 20_000)
    }),

  umountDevice: adminProcedure
    .input(z.object({
      mountpoint:      z.string().min(2),
      removeFromFstab: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      return await requestSync("root.sys.umount", input, 20_000)
    }),

  createRaid: adminProcedure
    .input(z.object({
      name:    z.string().regex(/^md[0-9]{1,3}$/),
      level:   z.number().int().refine(n => [0, 1, 5, 10].includes(n), { message: 'Invalid RAID level' }),
      devices: z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(2),
    }))
    .mutation(async ({ input }) => {
      return await requestSync("root.sys.raid.create", input, 120_000)
    }),

  stopRaid: adminProcedure
    .input(z.object({
      name: z.string().regex(/^md[0-9]{1,3}$/),
    }))
    .mutation(async ({ input }) => {
      return await requestSync("root.sys.raid.stop", input, 30_000)
    }),

  // ── LVM ────────────────────────────────────────────────────────────────────

  lvmInfo: adminProcedure.query(async () => {
    return await requestSync<{
      pvs: Array<{ name: string; vgName: string; size: number; free: number }>
      vgs: Array<{ name: string; size: number; free: number; pvCount: number; lvCount: number }>
      lvs: Array<{ name: string; vgName: string; size: number; path: string }>
    }>("root.sys.lvm.info", {}, 10_000)
  }),

  createPv: adminProcedure
    .input(z.object({ devices: z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(1) }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.pv.create", input, 30_000)),

  createVg: adminProcedure
    .input(z.object({
      name:    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
      devices: z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(1),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.vg.create", input, 30_000)),

  createLv: adminProcedure
    .input(z.object({
      vgName:    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
      lvName:    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
      sizeBytes: z.number().int().min(0),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.lv.create", input, 30_000)),

  removeLv: adminProcedure
    .input(z.object({
      vgName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
      lvName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.lv.remove", input, 20_000)),

  removeVg: adminProcedure
    .input(z.object({ vgName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/) }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.vg.remove", input, 20_000)),

  // ── Partitions ─────────────────────────────────────────────────────────────

  initPartitionTable: adminProcedure
    .input(z.object({ device: z.string().regex(/^[a-z][a-z0-9]+$/) }))
    .mutation(async ({ input }) => requestSync("root.sys.part.init", input, 15_000)),

  createPartition: adminProcedure
    .input(z.object({
      device:   z.string().regex(/^[a-z][a-z0-9]+$/),
      startPct: z.number().int().min(0).max(99).default(0),
      endPct:   z.number().int().min(1).max(100).default(100),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.part.create", input, 15_000)),

  deletePartition: adminProcedure
    .input(z.object({
      device:  z.string().regex(/^[a-z][a-z0-9]+$/),
      partNum: z.string().regex(/^[1-9][0-9]?$/),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.part.delete", input, 15_000)),
})
