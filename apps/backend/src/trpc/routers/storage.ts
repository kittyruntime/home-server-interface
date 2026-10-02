import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, storageProcedure, protectedProcedure, adminProcedure } from "../index"
import type { Context } from "../context"
import { normalizeDiskLabel } from "../../services/disk-labels"
import { activityEntries, activityWhere } from "../../services/storage-activity"
import { applyVolume, previewVolume, type VolumePlanDeps } from "../../services/volume-plan"
import { applyVolumeRemove, previewVolumeRemove, type RemoveTarget, type VolumeRemoveDeps } from "../../services/volume-remove-plan"
import { buildVolumes, type VDev, type VolumeInput } from "../../services/volumes"
import { desiredShareDefs, effectiveSmbName, syncSharesBestEffort, withShareLock } from "../../services/sharing.service"
import { PLAN_OPS, planAuditMeta, type PlanApplyResult, type PlanOp, type PlanStep } from "../../services/storage-plan"
import { prisma } from "@app/database"
import { appSources, fetchVolumes, resumeVolume, volumeStates } from "../../services/volume-guard"
import { requestSync } from "../../nats"

// Storage router: disks, partitions, RAID, LVM, mounts, SMART. Every procedure is a
// thin zod-validated proxy over a privileged NATS subject handled by the root-worker
// (apps/root-worker/disk.go). Monitoring/sysinfo live in the `system` router instead.
const zMaintenanceSchedule = z.object({
  every:   z.enum(["off", "daily", "weekly", "monthly"]),
  weekday: z.number().int().min(0).max(6),
  day:     z.number().int().min(1).max(28),
  hour:    z.number().int().min(0).max(23),
})
type MaintenanceSchedule = z.infer<typeof zMaintenanceSchedule>


// Inputs of the operations previewed as plans (#36); the per-op mutations
// below keep using them for compatibility.
const reDev = /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?$/
const reDisk = /^[a-z][a-z0-9]+$/
const reLvm = /^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/
const PLAN_INPUTS = {
  "format": z.object({
    // Bare name (sda1, md0) or relative LVM path (ubuntu-vg/ubuntu-lv)
    device: z.string().regex(reDev),
    fstype: z.enum(['ext4', 'xfs', 'btrfs', 'fat32']),
    label:  z.string().max(64).optional(),
  }),
  "mount": z.object({
    device:     z.string().regex(reDev),
    // Disallow whitespace and # to prevent fstab field injection
    mountpoint: z.string().min(2).max(255).regex(/^\/[^\s#]+$/, 'Invalid mount point'),
    options:    z.string().max(255).regex(/^[^\n\r\t]*$/, 'Invalid mount options').optional(),
    persist:    z.boolean().default(false),
    // "shared": a freshly formatted volume becomes writable by the user who
    // mounts it and the hsi-share group. "user": same, owned by ownerUserId.
    // "keep": leave its root as root:root.
    access:      z.enum(["shared", "user", "keep"]).default("keep"),
    ownerUserId: z.string().optional(),
    // Also prepare a volume that already holds data (confirmed in the UI).
    force:       z.boolean().default(false),
  }),
  "umount": z.object({
    mountpoint:      z.string().min(2),
    removeFromFstab: z.boolean().default(false),
  }),
  "raid.create": z.object({
    name:    z.string().regex(/^md[0-9]{1,3}$/),
    level:   z.number().int().refine(n => [0, 1, 5, 10].includes(n), { message: 'Invalid RAID level' }),
    devices: z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(2),
  }),
  "raid.stop": z.object({ name: z.string().regex(/^md[0-9]{1,3}$/) }),
  "pv.create": z.object({ devices: z.array(z.string().regex(reDisk)).min(1) }),
  "vg.create": z.object({ name: z.string().regex(reLvm), devices: z.array(z.string().regex(reDisk)).min(1) }),
  "lv.create": z.object({ vgName: z.string().regex(reLvm), lvName: z.string().regex(reLvm), sizeBytes: z.number().int().min(0) }),
  "lv.remove": z.object({ vgName: z.string().regex(reLvm), lvName: z.string().regex(reLvm) }),
  "vg.remove": z.object({ vgName: z.string().regex(reLvm) }),
  "part.init": z.object({ device: z.string().regex(reDisk) }),
  "part.create": z.object({
    device:   z.string().regex(reDisk),
    startPct: z.number().int().min(0).max(99).default(0),
    endPct:   z.number().int().min(1).max(100).default(100),
  }),
  "part.delete": z.object({ device: z.string().regex(reDisk), partNum: z.string().regex(/^[1-9][0-9]?$/) }),
  "raid.fail":   z.object({ name: z.string().regex(/^md[0-9]{1,3}$/), device: z.string().regex(/^[a-z][a-z0-9_-]*$/) }),
  "raid.remove": z.object({ name: z.string().regex(/^md[0-9]{1,3}$/), device: z.string().regex(/^[a-z][a-z0-9_-]*$/) }),
  "raid.add":    z.object({ name: z.string().regex(/^md[0-9]{1,3}$/), device: z.string().regex(/^[a-z][a-z0-9_-]*$/) }),
  "import.assemble": z.object({
    uuid:          z.string().regex(/^[0-9a-fA-F:]{8,64}$/),
    name:          z.string().regex(/^md[0-9]{1,3}$/),
    allowDegraded: z.boolean().default(false),
  }),
  "import.activate": z.object({ name: z.string().regex(/^[a-zA-Z0-9+_.][a-zA-Z0-9+_.-]{0,126}$/) }),
} satisfies Record<PlanOp, z.ZodTypeAny>

// The worker input for an operation: validated, and for a mount the owner is
// resolved to an HSI user's Linux name (never an arbitrary system account).
async function workerInput(ctx: Context & { user: { userId: string } }, op: PlanOp, raw: unknown): Promise<Record<string, unknown>> {
  const parsed = PLAN_INPUTS[op].safeParse(raw)
  if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error.issues[0]?.message ?? "Invalid input" })
  if (op !== "mount") return parsed.data as Record<string, unknown>
  const input = parsed.data as z.infer<typeof PLAN_INPUTS["mount"]>
  const { ownerUserId, ...rest } = input
  const ownerId = input.access === "user" ? ownerUserId : ctx.user.userId
  if (input.access === "user" && !ownerId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Choose the user who will own the volume" })
  }
  const owner = ownerId ? await ctx.prisma.user.findUnique({ where: { id: ownerId }, select: { username: true } }) : null
  if (input.access === "user" && !owner) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown user" })
  }
  return { ...rest, ownerUser: owner?.username ?? "" }
}


const zVolumeInput = z.object({
  volume: z.object({
    disks:      z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(1).max(24)
      .refine(d => new Set(d).size === d.length, "A disk is listed twice"),
    redundancy: z.enum(["none", "raid1", "raid5", "raid6", "raid10"]),
    vg:         z.string().min(1).max(31),
    lv:         z.string().min(1).max(31),
    lvPercent:  z.number().int().min(1).max(100),
    label:      z.string().min(1).max(16),
    // One spelling for the Place path, the audit target and the worker.
    mountpoint: z.string().startsWith("/").max(255).transform(p => p.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1")),
    // As for Mount: "shared" (the caller and hsi-share), "user" (ownerUserId),
    // "keep" (root:root). The owner is an HSI user, resolved here.
    access:      z.enum(["shared", "user", "keep"]).default("shared"),
    ownerUserId: z.string().optional(),
  }),
  place: z.object({ name: z.string().trim().min(1).max(64) }).optional(),
  share: z.object({ smbName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/).optional() }).optional(),
})

// The worker's volume.create input: the owner resolved to its account name.
async function workerVolume(ctx: Context & { user: { userId: string } }, v: z.infer<typeof zVolumeInput>["volume"]) {
  const { ownerUserId, access, ...rest } = v
  if (access === "keep") return { ...rest, access: "", ownerUser: "" }
  const ownerId = access === "user" ? ownerUserId : ctx.user.userId
  if (!ownerId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose the user who will own the volume" })
  const owner = await ctx.prisma.user.findUnique({ where: { id: ownerId }, select: { username: true } })
  if (!owner) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown user" })
  return { ...rest, access, ownerUser: owner.username }
}

// Dependencies of a create-volume plan, with today's Place and share checks.
async function volumeDeps(ctx: Context, input: z.infer<typeof zVolumeInput>, timeout: number): Promise<VolumePlanDeps> {
  const mp = input.volume.mountpoint
  if (input.place && await ctx.prisma.place.findFirst({ where: { path: mp } }))
    throw new TRPCError({ code: "CONFLICT", message: `A Place already exists at ${mp}` })
  const placeName = input.place?.name ?? ""
  const smbName = input.share ? effectiveSmbName({ smbName: input.share.smbName ?? null }, placeName) : ""
  if (input.share) {
    const others = await ctx.prisma.share.findMany({ include: { place: { select: { name: true } } } })
    if (others.some(s => effectiveSmbName(s, s.place.name).toLowerCase() === smbName.toLowerCase()))
      throw new TRPCError({ code: "CONFLICT", message: `Share name "${smbName}" is already in use` })
  }
  return {
    isAdmin: !!ctx.user?.isAdmin,
    worker: <T>(subject: string, payload: Record<string, unknown>) => requestSync<T>(subject, payload, timeout),
    smbdInstalled: () => requestSync<{ smbdInstalled: boolean }>("root.sharing.checkPrereqs", {}).then(r => r.smbdInstalled),
    shareDefs: () => desiredShareDefs(ctx.prisma, { kind: "create", row: {
      id: "(new)", placeId: "(new place)", smbName: input.share?.smbName ?? null, readOnly: false, guestOk: false, enabled: true,
      place: { name: placeName, path: mp },
    } }),
    serialize: withShareLock,
    resync: () => syncSharesBestEffort(ctx.prisma),
    createPlace: () => ctx.prisma.place.create({ data: { name: placeName, path: mp }, select: { id: true } }),
    createShare: (placeId: string) => ctx.prisma.share.create({ data: { placeId, smbName: input.share?.smbName ?? null, readOnly: false, guestOk: false } }),
  }
}

// Every data volume with its stack and what uses it (#40).
async function loadVolumes(ctx: Context) {
  const [block, lvm, guard, holds, places, shares, apps] = await Promise.all([
    requestSync<{ devices: VDev[]; raids: VolumeInput["raids"] }>("root.sys.blockdevices", {}, 15_000),
    requestSync<VolumeInput["lvm"]>("root.sys.lvm.info", {}, 10_000).catch(() => ({ pvs: [], vgs: [], lvs: [] })),
    volumeStates.get().catch(() => []),
    ctx.prisma.volumeHold.findMany(),
    ctx.prisma.place.findMany({ select: { id: true, name: true, path: true } }),
    ctx.prisma.share.findMany({ where: { enabled: true }, include: { place: { select: { name: true } } } }),
    appSources().catch(() => []),
  ])
  return buildVolumes({
    devices: block.devices ?? [],
    raids: block.raids ?? [],
    lvm,
    guard,
    holds,
    places,
    shares: shares.map(s => ({ placeId: s.placeId, name: effectiveSmbName(s, s.place.name) })),
    apps,
  })
}

// The volume to remove and what uses it, read from the server now.
async function removeTarget(ctx: Context, id: string): Promise<RemoveTarget> {
  const v = (await loadVolumes(ctx)).volumes.find(x => x.id === id)
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "This volume is no longer on the server" })
  if (v.state === "missing") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This volume is missing: its disks are not connected" })
  return {
    uuid: v.id, mountPoint: v.mountPoint ?? v.expectedMountPoint ?? "", name: v.name,
    places: v.usedBy.places, apps: v.usedBy.apps, shared: v.usedBy.shares.length > 0,
  }
}

function removeDeps(ctx: Context, timeout: number): VolumeRemoveDeps {
  return {
    worker: <T>(subject: string, payload: Record<string, unknown>) => requestSync<T>(subject, payload, timeout),
    smbdInstalled: () => requestSync<{ smbdInstalled: boolean }>("root.sharing.checkPrereqs", {}).then(r => r.smbdInstalled),
    shareDefsWithout: async (placeIds: string[]) => {
      const gone = await ctx.prisma.place.findMany({ where: { id: { in: placeIds } }, select: { path: true } })
      const paths = new Set(gone.map(p => p.path))
      return (await desiredShareDefs(ctx.prisma)).filter(d => !paths.has(d.path))
    },
    serialize: withShareLock,
    resync: () => syncSharesBestEffort(ctx.prisma),
    deletePlace: async (id: string) => { await ctx.prisma.place.delete({ where: { id } }) },
    releaseHold: async (mountPoint: string) => { await ctx.prisma.volumeHold.deleteMany({ where: { mountPoint } }) },
  }
}

export const storageRouter = router({
  // Operation plans (#36): preview what a storage operation will do, then
  // apply exactly that plan. Mutations, so inputs never travel in URLs.
  plan: storageProcedure
    .input(z.object({ op: z.enum(PLAN_OPS), input: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const workerIn = await workerInput(ctx, input.op, input.input)
      return await requestSync<{ steps: PlanStep[]; fingerprint: string }>("root.plan.preview", { op: input.op, input: workerIn }, 60_000)
    }),

  apply: storageProcedure
    .input(z.object({ op: z.enum(PLAN_OPS), input: z.unknown(), fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const workerIn = await workerInput(ctx, input.op, input.input)
      let res: PlanApplyResult
      try {
        res = await requestSync<PlanApplyResult>("root.plan.apply", { op: input.op, input: workerIn, fingerprint: input.fingerprint }, 180_000)
      } catch (e) {
        const code = (e as { code?: string }).code
        const message = e instanceof Error ? e.message : String(e)
        throw new TRPCError({ code: code === "ESTALE" ? "CONFLICT" : "BAD_REQUEST", message })
      }
      ctx.audit.meta = { plan: planAuditMeta(input.op, res.steps, res.results) }
      ctx.audit.success = res.ok
      return res
    }),

  // Create volume (#40): the worker chain, a Place and a share, as one plan.
  volumePlan: storageProcedure
    .input(z.object({ input: zVolumeInput }))
    .mutation(async ({ ctx, input }) => {
      ctx.audit.target = input.input.volume.mountpoint
      const deps = await volumeDeps(ctx, input.input, 60_000)
      return previewVolume({ ...input.input, volume: await workerVolume(ctx, input.input.volume) }, deps)
    }),
  volumeApply: storageProcedure
    .input(z.object({ input: zVolumeInput, fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      ctx.audit.target = input.input.volume.mountpoint
      const deps = await volumeDeps(ctx, input.input, 900_000)
      const res = await applyVolume({ ...input.input, volume: await workerVolume(ctx, input.input.volume) }, input.fingerprint, deps)
      ctx.audit.meta = { plan: planAuditMeta("volume.create", res.steps, res.results) }
      ctx.audit.success = res.ok
      return res
    }),

  // Remove volume (#40): its shares, the worker chain and its Places, as one plan.
  volumeRemovePlan: adminProcedure
    .input(z.object({ id: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const target = await removeTarget(ctx, input.id)
      ctx.audit.target = target.mountPoint || target.name
      return previewVolumeRemove(target, removeDeps(ctx, 60_000))
    }),
  volumeRemoveApply: adminProcedure
    .input(z.object({ id: z.string().min(1).max(128), fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const target = await removeTarget(ctx, input.id)
      ctx.audit.target = target.mountPoint || target.name
      const res = await applyVolumeRemove(target, input.fingerprint, removeDeps(ctx, 900_000))
      ctx.audit.meta = { plan: planAuditMeta("volume.remove", res.steps, res.results) }
      ctx.audit.success = res.ok
      return res
    }),

  // Recent operations on a storage object (#40): audit entries whose target
  // is exactly one of the object's names (device, /dev path, mount point, UUID).
  activity: storageProcedure
    .input(z.object({
      targets: z.array(z.string().min(1).max(512)).min(1).max(20),
      arrays:  z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)).max(5).optional(),
    }))
    .query(async ({ input }) => activityEntries(await prisma.auditLog.findMany({
      where: activityWhere(input.targets, input.arrays),
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { user: { select: { username: true } } },
    }))),

  // Names given to physical disks, by serial (#32).
  diskLabels: router({
    list: storageProcedure.query(async () =>
      (await prisma.diskLabel.findMany()).map(l => ({ serial: l.serial, label: l.label }))),
    set: storageProcedure
      .input(z.object({ serial: z.string().trim().min(1).max(128), label: z.string().max(200) }))
      .mutation(async ({ input }) => {
        const label = normalizeDiskLabel(input.label)
        if (label === null) {
          await prisma.diskLabel.deleteMany({ where: { serial: input.serial } })
        } else {
          await prisma.diskLabel.upsert({ where: { serial: input.serial }, create: { serial: input.serial, label }, update: { label } })
        }
        return { serial: input.serial, label }
      }),
  }),

  // Missing volume guard (#3): state of each HSI volume and its hold.
  volumes: router({
    // The Volumes landing page (#40): every data filesystem with its stack,
    // redundancy, space, issues and what uses it.
    overview: storageProcedure.query(({ ctx }) => loadVolumes(ctx)),

    list: storageProcedure.query(async () => {
      const [volumes, holds] = await Promise.all([fetchVolumes().catch(() => []), prisma.volumeHold.findMany()])
      return volumes.map(v => {
        const h = holds.find(x => x.mountPoint === v.mountPoint)
        return {
          ...v,
          hold: h ? { status: h.status as "blocked" | "back", reason: h.reason, since: h.since, stoppedApps: JSON.parse(h.stoppedApps) as string[], strayFiles: h.strayFiles } : null,
        }
      })
    }),
    // Read by the Apps and Sharing views to show what is blocked.
    holds: protectedProcedure.query(async () => {
      const holds = await prisma.volumeHold.findMany()
      return holds.map(h => ({ mountPoint: h.mountPoint, status: h.status, reason: h.reason, stoppedApps: JSON.parse(h.stoppedApps) as string[] }))
    }),
    resume: storageProcedure.input(z.object({ mountPoint: z.string() })).mutation(({ input }) => resumeVolume(input.mountPoint)),
  }),

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
      // mounts it and the hsi-share group. "user": same, owned by ownerUserId.
      // "keep": leave its root as root:root.
      access:      z.enum(["shared", "user", "keep"]).default("keep"),
      ownerUserId: z.string().optional(),
      // Also prepare a volume that already holds data (confirmed in the UI).
      force:       z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const { ownerUserId, ...rest } = input
      // Owners are HSI users only, never an arbitrary system account.
      const ownerId = input.access === "user" ? ownerUserId : ctx.user.userId
      if (input.access === "user" && !ownerId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Choose the user who will own the volume" })
      }
      const owner = ownerId
        ? await ctx.prisma.user.findUnique({ where: { id: ownerId }, select: { username: true } })
        : null
      if (input.access === "user" && !owner) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown user" })
      }
      return await requestSync<{ ok: true; warnings?: string[] | null }>(
        "root.sys.mount", { ...rest, ownerUser: owner?.username ?? "" }, 20_000)
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
  // Import existing storage without formatting: arrays found in superblocks
  // that are not running, and volume groups with no active logical volume.
  importScan: storageProcedure.query(async () => requestSync<{
    arrays: Array<{ device: string; level: string; uuid: string; name: string; expected: number; members: string[]; missing: number }>
    vgs: Array<{ name: string; lvs: string[] }>
  }>("root.sys.import.scan", {}, 30_000)),

  importAssembleRaid: storageProcedure
    .input(z.object({
      uuid:          z.string().regex(/^[0-9a-fA-F:]{8,64}$/),
      name:          z.string().regex(/^md[0-9]{1,3}$/),
      allowDegraded: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => requestSync<{ ok: true; device: string; warnings?: string[] | null }>(
      "root.sys.import.assemble", input, 60_000)),

  importActivateVg: storageProcedure
    .input(z.object({ name: z.string().regex(/^[a-zA-Z0-9+_.][a-zA-Z0-9+_.-]{0,126}$/) }))
    .mutation(async ({ input }) => requestSync("root.sys.import.activateVg", input, 60_000)),

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
      // Skip a disk in standby instead of spinning it up (list-wide health).
      noWake: z.boolean().optional(),
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
