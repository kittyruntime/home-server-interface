import { z } from "zod"
import { router, storageProcedure } from "../index"
import { requestSync } from "../../nats"

// Storage router — disks, partitions, RAID, LVM, mounts, SMART. Every procedure is a
// thin zod-validated proxy over a privileged NATS subject handled by the root-worker
// (apps/root-worker/disk.go). Monitoring/sysinfo live in the `system` router instead.
const zMaintenanceSchedule = z.object({
  every:   z.enum(["off", "daily", "weekly", "monthly"]),
  weekday: z.number().int().min(0).max(6),
  day:     z.number().int().min(1).max(28),
  hour:    z.number().int().min(0).max(23),
})
type MaintenanceSchedule = z.infer<typeof zMaintenanceSchedule>

export const storageRouter = router({
  disks: storageProcedure.query(async () => {
    return await requestSync<{
      disks: Array<{ device: string; mountPoint: string; fsType: string; total: number; used: number; free: number }>
      raids: Array<{ name: string; level: string; state: string; devices: string[]; active: number; total: number }>
    }>("root.sys.disks", {})
  }),

  blockDevices: storageProcedure.query(async () => {
    return await requestSync<{
      devices: unknown[]
      raids: Array<{ name: string; level: string; state: string; devices: string[]; active: number; total: number }>
    }>("root.sys.blockdevices", {}, 15_000)
  }),

  formatDisk: storageProcedure
    .input(z.object({
      // Bare name (sda1, md0) or relative LVM path (ubuntu-vg/ubuntu-lv)
      device: z.string().regex(/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?$/),
      fstype: z.enum(['ext4', 'xfs', 'btrfs', 'fat32']),
      label:  z.string().max(64).optional(),
    }))
    .mutation(async ({ input }) => {
      return await requestSync("root.sys.format", input, 120_000)
    }),

  mountDevice: storageProcedure
    .input(z.object({
      device:     z.string().regex(/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?$/),
      // Disallow whitespace and # to prevent fstab field injection
      mountpoint: z.string().min(2).max(255).regex(/^\/[^\s#]+$/, 'Invalid mount point'),
      options:    z.string().max(255).regex(/^[^\n\r\t]*$/, 'Invalid mount options').optional(),
      persist:    z.boolean().default(false),
      // "shared": a freshly formatted volume becomes writable by the user who
      // mounts it and the hsi-share group. "keep": leave its root as root:root.
      access:     z.enum(["shared", "keep"]).default("keep"),
    }))
    .mutation(async ({ ctx, input }) => {
      const me = await ctx.prisma.user.findUnique({ where: { id: ctx.user.userId }, select: { username: true } })
      return await requestSync<{ ok: true; warnings?: string[] | null }>(
        "root.sys.mount", { ...input, ownerUser: me?.username ?? "" }, 20_000)
    }),

  umountDevice: storageProcedure
    .input(z.object({
      mountpoint:      z.string().min(2),
      removeFromFstab: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      return await requestSync("root.sys.umount", input, 20_000)
    }),

  createRaid: storageProcedure
    .input(z.object({
      name:    z.string().regex(/^md[0-9]{1,3}$/),
      level:   z.number().int().refine(n => [0, 1, 5, 10].includes(n), { message: 'Invalid RAID level' }),
      devices: z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(2),
    }))
    .mutation(async ({ input }) => {
      return await requestSync("root.sys.raid.create", input, 120_000)
    }),

  // Replacing a failed member: fail it, remove it, add a replacement (mdadm
  // then rebuilds). The worker refuses unsuitable devices (in use, too small).
  failRaidMember: storageProcedure
    .input(z.object({ name: z.string().regex(/^md[0-9]{1,3}$/), device: z.string().regex(/^[a-z][a-z0-9_-]*$/) }))
    .mutation(async ({ input }) => requestSync("root.sys.raid.fail", input, 30_000)),

  removeRaidMember: storageProcedure
    .input(z.object({ name: z.string().regex(/^md[0-9]{1,3}$/), device: z.string().regex(/^[a-z][a-z0-9_-]*$/) }))
    .mutation(async ({ input }) => requestSync("root.sys.raid.remove", input, 30_000)),

  addRaidMember: storageProcedure
    .input(z.object({ name: z.string().regex(/^md[0-9]{1,3}$/), device: z.string().regex(/^[a-z][a-z0-9_-]*$/) }))
    .mutation(async ({ input }) => requestSync("root.sys.raid.add", input, 60_000)),

  // Scheduled disk checks (SMART self-tests, RAID consistency checks). The
  // schedule is run by a systemd timer, independently of the backend.
  maintenance: storageProcedure.query(async () => requestSync<{
    timerInstalled: boolean
    tasks: Record<"smartShort" | "smartLong" | "raidCheck", {
      schedule: MaintenanceSchedule
      lastRun: string | null
      nextRun: string | null
      results: Array<{ device: string; serial?: string; status: "started" | "skipped" | "error"; message?: string }> | null
    }>
  }>("root.sys.maintenance.get", {}, 10_000)),

  setMaintenance: storageProcedure
    .input(z.object({ smartShort: zMaintenanceSchedule, smartLong: zMaintenanceSchedule, raidCheck: zMaintenanceSchedule }))
    .mutation(async ({ input }) => requestSync("root.sys.maintenance.set", input, 10_000)),

  runMaintenanceNow: storageProcedure
    .input(z.object({ task: z.enum(["smartShort", "smartLong", "raidCheck"]) }))
    .mutation(async ({ input }) => requestSync("root.sys.maintenance.runNow", input, 120_000)),

  stopRaid: storageProcedure
    .input(z.object({
      name: z.string().regex(/^md[0-9]{1,3}$/),
    }))
    .mutation(async ({ input }) => {
      return await requestSync<{ ok: true; warnings?: string[] | null }>("root.sys.raid.stop", input, 60_000)
    }),

  // Host commands each feature needs, so the dashboard can explain a missing
  // package before an action fails.
  tools: storageProcedure.query(async () => {
    return await requestSync<{
      tools: Array<{ command: string; package: string; feature: string; available: boolean }>
    }>("root.sys.tools", {}, 5_000)
  }),

  smartInfo: storageProcedure
    .input(z.object({
      device: z.string().regex(/^[a-z][a-z0-9]+$/), // bare name only: sda, nvme0n1
    }))
    .query(async ({ input }) => {
      return await requestSync("root.sys.smart", input, 15_000)
    }),

  // ── LVM ────────────────────────────────────────────────────────────────────

  lvmInfo: storageProcedure.query(async () => {
    return await requestSync<{
      pvs: Array<{ name: string; vgName: string; size: number; free: number }>
      vgs: Array<{ name: string; size: number; free: number; pvCount: number; lvCount: number }>
      lvs: Array<{ name: string; vgName: string; size: number; path: string }>
    }>("root.sys.lvm.info", {}, 10_000)
  }),

  createPv: storageProcedure
    .input(z.object({ devices: z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(1) }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.pv.create", input, 30_000)),

  createVg: storageProcedure
    .input(z.object({
      name:    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
      devices: z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(1),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.vg.create", input, 30_000)),

  createLv: storageProcedure
    .input(z.object({
      vgName:    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
      lvName:    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
      sizeBytes: z.number().int().min(0),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.lv.create", input, 30_000)),

  removeLv: storageProcedure
    .input(z.object({
      vgName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
      lvName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.lv.remove", input, 20_000)),

  removeVg: storageProcedure
    .input(z.object({ vgName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/) }))
    .mutation(async ({ input }) => requestSync("root.sys.lvm.vg.remove", input, 20_000)),

  // ── Partitions ─────────────────────────────────────────────────────────────

  initPartitionTable: storageProcedure
    .input(z.object({ device: z.string().regex(/^[a-z][a-z0-9]+$/) }))
    .mutation(async ({ input }) => requestSync("root.sys.part.init", input, 15_000)),

  createPartition: storageProcedure
    .input(z.object({
      device:   z.string().regex(/^[a-z][a-z0-9]+$/),
      startPct: z.number().int().min(0).max(99).default(0),
      endPct:   z.number().int().min(1).max(100).default(100),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.part.create", input, 15_000)),

  deletePartition: storageProcedure
    .input(z.object({
      device:  z.string().regex(/^[a-z][a-z0-9]+$/),
      partNum: z.string().regex(/^[1-9][0-9]?$/),
    }))
    .mutation(async ({ input }) => requestSync("root.sys.part.delete", input, 15_000)),
})
