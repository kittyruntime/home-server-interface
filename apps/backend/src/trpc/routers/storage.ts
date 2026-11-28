import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, storageProcedure, protectedProcedure, adminProcedure } from '../index'
import type { Context } from '../context'
import { normalizeDiskLabel } from '../../services/disk-labels'
import { activityEntries, activityWhere } from '../../services/storage-activity'
import { applyVolume, previewVolume, type VolumePlanDeps } from '../../services/volume-plan'
import { applyVolumeRemove, previewVolumeRemove, removeTargetOf, type RemoveTarget, type VolumeRemoveDeps } from '../../services/volume-remove-plan'
import { expandOptions, type ExpandInput, type PendingExpansion } from '../../services/expand-options'
import type { DescriptionStatus } from '../../services/storage-descriptions'
import { buildVolumes, type VDev, type VolumeInput } from '../../services/volumes'
import { NO_ZFS, zfsDestroyBlocker, type ZfsInfo, type ZfsVdev } from '../../services/zfs-volumes'
import { totalmem } from 'node:os'
import { currentSmbSettings, desiredShareDefs, effectiveSmbName, syncPlaceAccess, syncSharesBestEffort, withShareLock } from '../../services/sharing.service'
import { PLAN_OPS, planAuditMeta, type PlanApplyResult, type PlanOp, type PlanStep } from '../../services/storage-plan'
import { prisma } from '@app/database'
import { appSources, fetchVolumes, resumeVolume, volumeStates } from '../../services/volume-guard'
import { requestSync } from '../../nats'

// Storage router: disks, partitions, RAID, LVM, mounts, SMART. Every procedure is a
// thin zod-validated proxy over a privileged NATS subject handled by the root-worker
// (apps/root-worker/disk.go). Monitoring/sysinfo live in the `system` router instead.
const zMaintenanceSchedule = z.object({
  every:   z.enum(['off', 'daily', 'weekly', 'monthly']),
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
// Versioned backups (#15). The worker stays the authority; this refuses the obvious.
const zBackupId = z.string().regex(/^[0-9a-f-]{36}$/)
const zBackupPath = z.string().trim().min(1).max(4096).startsWith('/')
const zSshKeyPath = z.string().max(4096).regex(/^\/[A-Za-z0-9._/-]+$/, 'Invalid SSH key path')
  .refine(p => p.split('/').every(part => part !== '..' && !part.startsWith('-')), 'Invalid SSH key path')
const zBackupName = z.string().trim().min(1).max(80)
const zBackupExcludes = z.array(z.string().min(1).max(255).regex(/^[^\0\r\n]+$/)).max(50)
const zRetention = z.number().int().min(0).max(1000)
const zBackupPlan = z.object({
  id: zBackupId,
  name: zBackupName,
  type: z.enum(['sync', 'versions']),
  enabled: z.boolean(),
  schedule: z.object({
    every: z.enum(['manual', 'hourly', 'daily', 'weekly']),
    minute: z.number().int().min(0).max(59), hour: z.number().int().min(0).max(23), weekday: z.number().int().min(0).max(6),
  }),
  sync: z.object({
    direction: z.enum(['push', 'pull']),
    source: zBackupPath, destination: zBackupPath,
    remoteHost: z.string().max(253).regex(/^([a-zA-Z0-9][a-zA-Z0-9.-]*)?$/),
    remoteUser: z.string().max(32).regex(/^([a-z_][a-z0-9_-]*)?$/),
    remotePort: z.number().int().min(1).max(65535),
    sshKeyPath: z.union([z.literal(''), zSshKeyPath]),
    deleteExtra: z.boolean(), compress: z.boolean(),
    bandwidthLimit: z.number().int().min(0).max(1_048_576),
    excludes: zBackupExcludes,
  }).optional(),
  versions: z.object({
    sources: z.array(zBackupPath).min(1).max(20),
    repository: zBackupId,
    excludes: zBackupExcludes,
    stopApps: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)).max(20),
    retention: z.object({ keepLast: zRetention, keepDaily: zRetention, keepWeekly: zRetention, keepMonthly: zRetention }),
  }).optional(),
})
const zBackupRepository = z.object({
  id: zBackupId,
  name: zBackupName,
  type: z.enum(['local', 'sftp', 's3', 'rest']),
  path: z.string().max(4096).default(''), host: z.string().max(253).default(''), user: z.string().max(32).default(''),
  port: z.number().int().min(0).max(65535).default(0),
  endpoint: z.string().max(260).default(''), bucket: z.string().max(63).default(''), url: z.string().max(2048).default(''),
  check: z.object({
    every: z.enum(['off', 'daily', 'weekly', 'monthly']),
    hour: z.number().int().min(0).max(23), weekday: z.number().int().min(0).max(6), day: z.number().int().min(0).max(28),
    subset: z.string().max(4),
  }),
})
// A blank secret keeps the stored value.
const zBackupSecrets = z.object({
  password: z.string().max(1024).default(''),
  sshKeyPath: z.union([z.literal(''), zSshKeyPath]).default(''),
  accessKeyId: z.string().max(256).default(''),
  secretAccessKey: z.string().max(1024).default(''),
  restUser: z.string().max(256).default(''),
  restPassword: z.string().max(1024).default(''),
})
export type ZfsSnap = { name: string; dataset: string; short: string; created: number; used: number; refer: number }
export type ZfsSnapRule = { dataset: string; every: 'hourly' | 'daily' | 'weekly' | 'monthly'; keep: number }
const zSnapPath = z.string().max(4096).refine(p => !p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..'), 'invalid path')

const PLAN_INPUTS = {
  'format': z.object({
    // Bare name (sda1, md0) or relative LVM path (ubuntu-vg/ubuntu-lv)
    device: z.string().regex(reDev),
    fstype: z.enum(['ext4', 'xfs', 'btrfs', 'fat32']),
    label:  z.string().max(64).optional(),
  }),
  'mount': z.object({
    device:     z.string().regex(reDev),
    // Disallow whitespace and # to prevent fstab field injection
    mountpoint: z.string().min(2).max(255).regex(/^\/[^\s#]+$/, 'Invalid mount point'),
    options:    z.string().max(255).regex(/^[^\n\r\t]*$/, 'Invalid mount options').optional(),
    persist:    z.boolean().default(false),
    // "shared": a freshly formatted volume becomes writable by the user who
    // mounts it and the hsi-share group. "user": same, owned by ownerUserId.
    // "keep": leave its root as root:root.
    access:      z.enum(['shared', 'user', 'keep']).default('keep'),
    ownerUserId: z.string().optional(),
    // Also prepare a volume that already holds data (confirmed in the UI).
    force:       z.boolean().default(false),
  }),
  'umount': z.object({
    mountpoint:      z.string().min(2),
    removeFromFstab: z.boolean().default(false),
  }),
  'raid.create': z.object({
    name:    z.string().regex(/^md[0-9]{1,3}$/),
    level:   z.number().int().refine(n => [0, 1, 5, 10].includes(n), { message: 'Invalid RAID level' }),
    devices: z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(2),
  }),
  'raid.stop': z.object({ name: z.string().regex(/^md[0-9]{1,3}$/) }),
  'pv.create': z.object({ devices: z.array(z.string().regex(reDisk)).min(1) }),
  'vg.create': z.object({ name: z.string().regex(reLvm), devices: z.array(z.string().regex(reDisk)).min(1) }),
  'lv.create': z.object({ vgName: z.string().regex(reLvm), lvName: z.string().regex(reLvm), sizeBytes: z.number().int().min(0) }),
  'lv.remove': z.object({ vgName: z.string().regex(reLvm), lvName: z.string().regex(reLvm) }),
  'vg.remove': z.object({ vgName: z.string().regex(reLvm) }),
  'part.init': z.object({ device: z.string().regex(reDisk) }),
  'part.create': z.object({
    device:   z.string().regex(reDisk),
    startPct: z.number().int().min(0).max(99).default(0),
    endPct:   z.number().int().min(1).max(100).default(100),
  }),
  'part.delete': z.object({ device: z.string().regex(reDisk), partNum: z.string().regex(/^[1-9][0-9]?$/) }),
  'raid.fail':   z.object({ name: z.string().regex(/^md[0-9]{1,3}$/), device: z.string().regex(/^[a-z][a-z0-9_-]*$/) }),
  'raid.remove': z.object({ name: z.string().regex(/^md[0-9]{1,3}$/), device: z.string().regex(/^[a-z][a-z0-9_-]*$/) }),
  'raid.add':    z.object({ name: z.string().regex(/^md[0-9]{1,3}$/), device: z.string().regex(/^[a-z][a-z0-9_-]*$/) }),
  'import.assemble': z.object({
    uuid:          z.string().regex(/^[0-9a-fA-F:]{8,64}$/),
    name:          z.string().regex(/^md[0-9]{1,3}$/).optional(),
    allowDegraded: z.boolean().default(false),
  }),
  'import.activate': z.object({ name: z.string().regex(/^[a-zA-Z0-9+_.][a-zA-Z0-9+_.-]{0,126}$/) }),
  // ZFS (lot 1): the worker checks the same rules.
  'zfs.import': z.object({ guid: z.string().regex(/^[0-9]{1,20}$/), name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/), force: z.boolean().optional() }),
  'zfs.watch': z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/) }),
  'zfs.unwatch': z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/) }),
  'zfs.pool.create': z.object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/),
    layout: z.enum(['stripe', 'mirror', 'raidz1', 'raidz2', 'raidz3']),
    disks: z.array(z.string().regex(/^[a-z][a-z0-9]{1,31}$/)).min(1).max(64),
    compression: z.enum(['lz4', 'zstd', 'off']),
  }),
  'zfs.pool.destroy': z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/) }),
  'zfs.dataset.create': z.object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}(\/[A-Za-z0-9_.:-]{1,64})+$/),
    quota: z.number().int().min(0).optional(),
    compression: z.enum(['inherit', 'lz4', 'zstd', 'off']).optional(),
  }),
  'zfs.dataset.set': z.object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}(\/[A-Za-z0-9_.:-]{1,64})*$/),
    quota: z.number().int().min(0),
    compression: z.enum(['lz4', 'zstd', 'off']),
  }),
  'zfs.scrub': z.object({ pool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/), stop: z.boolean().optional() }),
  'zfs.clear': z.object({ pool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/) }),
  // The leaf as zpool prints it: a device path, or a guid when it is missing.
  'zfs.replace': z.object({ pool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/), leaf: z.string().regex(/^(\/dev\/[A-Za-z0-9_.:/-]{1,200}|[0-9]{1,20})$/), disk: z.string().regex(/^[a-z][a-z0-9]{1,31}$/) }),
  // Snapshots (lot 4): a path inside a snapshot is relative, never with '..'.
  'zfs.snapshot.create': z.object({ dataset: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}(\/[A-Za-z0-9_.:-]{1,64})*$/) }),
  'zfs.snapshot.destroy': z.object({ snapshot: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}(\/[A-Za-z0-9_.:-]{1,64})*@[A-Za-z0-9_.:-]{1,128}$/) }),
  'zfs.snapshot.rollback': z.object({ snapshot: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}(\/[A-Za-z0-9_.:-]{1,64})*@[A-Za-z0-9_.:-]{1,128}$/) }),
  'zfs.snapshot.restore': z.object({ snapshot: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}(\/[A-Za-z0-9_.:-]{1,64})*@[A-Za-z0-9_.:-]{1,128}$/), path: zSnapPath.refine(p => p !== '', 'pick a file or a folder') }),
  'zfs.snapshot.rules': z.object({ rules: z.array(z.object({ dataset: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}(\/[A-Za-z0-9_.:-]{1,64})*$/), every: z.enum(['hourly', 'daily', 'weekly', 'monthly']), keep: z.number().int().min(1).max(1000) })).max(200) }),
  // Growing a pool (lot 5).
  'zfs.pool.add': z.object({ pool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/), disks: z.array(z.string().regex(/^[a-z][a-z0-9]{1,31}$/)).min(1).max(24) }),
  'zfs.pool.expand': z.object({ pool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/) }),
  'zfs.pool.attach': z.object({ pool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/), vdev: z.string().regex(/^(mirror|raidz[1-3])-[0-9]{1,4}$/), disk: z.string().regex(/^[a-z][a-z0-9]{1,31}$/) }),
  'zfs.dataset.destroy': z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}(\/[A-Za-z0-9_.:-]{1,64})+$/) }),
  // Expand a volume (#7): the filesystem UUID, the way, and the disk to add.
  'volume.expand': z.object({
    uuid: z.string().min(1).max(128).regex(/^[A-Za-z0-9-]+$/),
    mode: z.enum(['vgFree', 'addDisk', 'raidAddDisk', 'mirrorGrow']),
    disk: z.string().regex(/^[a-z][a-z0-9]+$/).optional(),
  }),
  // Storage descriptions (#37): put the server back in line, or describe it as it is.
  'storage.reapply': z.object({
    mountPoint: z.string().min(2).max(255).regex(/^\/[^\s#]+$/, 'Invalid mount point'),
    degraded:   z.boolean().default(false),
  }),
  // Server identity (#12): hostname and time zone, admins only.
  'system.identity': z.object({
    hostname: z.string().max(63).regex(/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/, 'A hostname uses letters, digits and hyphens, and does not start or end with a hyphen').optional(),
    timezone: z.string().max(64).regex(/^[A-Za-z0-9_+\-/]+$/, 'Invalid time zone').optional(),
  }),
  // Network (#11): IPv4 addressing and DNS of one interface, admins only.
  'network.ipv4': z.object({
    device:  z.string().regex(/^[A-Za-z0-9._-]{1,15}$/),
    method:  z.enum(['auto', 'manual']),
    address: z.string().max(18).optional(),
    gateway: z.string().max(15).optional(),
    dns:     z.array(z.string().max(15)).max(3).default([]),
  }),
  // Managed HTTPS (#12): admins only. The key of an imported certificate is
  // redacted from the audit log by name (see redactForAudit).
  'tls.enable': z.object({}),
  'tls.useLocal': z.object({}),
  'tls.import': z.object({ cert: z.string().min(1).max(256_000), key: z.string().max(64_000).default('') }),
  'tls.proxy': z.object({ trustedProxies: z.array(z.string().min(1).max(64)).max(32) }),
  'tls.standardPorts': z.object({ enabled: z.boolean() }),
  'backup.plan.save': z.object({ plan: zBackupPlan }),
  'backup.plan.remove': z.object({ id: zBackupId }),
  'backup.repository.save': z.object({ repository: zBackupRepository, secrets: zBackupSecrets }),
  'backup.repository.remove': z.object({ id: zBackupId }),
  'backup.restore': z.object({
    repository: zBackupId,
    snapshot: z.string().regex(/^[0-9a-f]{8,64}$/),
    path: zBackupPath,
    target: z.enum(['new', 'original']),
    confirmOverwrite: z.boolean().optional(),
  }),
  'storage.accept': z.object({
    mountPoint: z.string().min(2).max(255).regex(/^\/[^\s#]+$/, 'Invalid mount point'),
  }),
} satisfies Record<PlanOp, z.ZodTypeAny>

// The worker input for an operation: validated, and for a mount the owner is
// resolved to an HSI user's Linux name (never an arbitrary system account).
async function workerInput(ctx: Context & { user: { userId: string } }, op: PlanOp, raw: unknown): Promise<Record<string, unknown>> {
  // The server's hostname and time zone (#12): admins only.
  if (op === 'system.identity' && !ctx.user?.isAdmin)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only an admin can change the server identity' })
  if (op === 'network.ipv4' && !ctx.user?.isAdmin)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only an admin can change the network' })
  if (op.startsWith('tls.') && !ctx.user?.isAdmin)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only an admin can change secure access' })
  // Expanding rewrites whole arrays and erases the disk it adds: admins only.
  if (op === 'volume.expand' && !ctx.user?.isAdmin)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only an admin can expand a volume' })
  if (op.startsWith('backup.') && !ctx.user?.isAdmin)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only an admin can change backups' })
  // Importing a pool mounts disks brought from elsewhere: admins only.
  if (op.startsWith('zfs.') && !ctx.user?.isAdmin)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only an admin can manage ZFS pools and datasets' })
  const parsed = PLAN_INPUTS[op].safeParse(raw)
  if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid input' })
  // A ZFS delete waits until nothing uses what it removes, as for an LVM volume.
  if (op === 'zfs.dataset.destroy' || op === 'zfs.pool.destroy') {
    const [overview, zfs, places, apps] = await Promise.all([
      loadVolumes(ctx, { strict: true }), loadZfs(),
      ctx.prisma.place.findMany({ select: { name: true, path: true } }), appSources(),
    ])
    const datasets = [...zfs.datasets, ...zfs.watched.flatMap(w => w.datasets)]
    // Shares are on Places: a Place under the dataset covers its share.
    const uses = [...places.map(p => ({ what: `Place ${p.name}`, path: p.path })), ...apps.flatMap(a => a.sources.map(path => ({ what: `app ${a.name}`, path })))]
    const blocker = zfsDestroyBlocker(overview.volumes, op, parsed.data as { name: string }, datasets, uses)
    if (blocker) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: blocker })
  }
  if (op !== 'mount') return parsed.data as Record<string, unknown>
  const input = parsed.data as z.infer<typeof PLAN_INPUTS['mount']>
  const { ownerUserId, ...rest } = input
  const ownerId = input.access === 'user' ? ownerUserId : ctx.user.userId
  if (input.access === 'user' && !ownerId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose the user who will own the volume' })
  }
  const owner = ownerId ? await ctx.prisma.user.findUnique({ where: { id: ownerId }, select: { username: true } }) : null
  if (input.access === 'user' && !owner) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown user' })
  }
  return { ...rest, ownerUser: owner?.username ?? '' }
}

const zVolumeInput = z.object({
  volume: z.object({
    disks:      z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(1).max(24)
      .refine(d => new Set(d).size === d.length, 'A disk is listed twice'),
    redundancy: z.enum(['none', 'raid1', 'raid5', 'raid6', 'raid10']),
    vg:         z.string().min(1).max(31),
    lv:         z.string().min(1).max(31),
    lvPercent:  z.number().int().min(1).max(100),
    label:      z.string().min(1).max(16),
    // One spelling for the Place path, the audit target and the worker.
    mountpoint: z.string().startsWith('/').max(255).transform(p => p.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')),
    // As for Mount: "shared" (the caller and hsi-share), "user" (ownerUserId),
    // "keep" (root:root). The owner is an HSI user, resolved here.
    access:      z.enum(['shared', 'user', 'keep']).default('shared'),
    ownerUserId: z.string().optional(),
  }),
  place: z.object({ name: z.string().trim().min(1).max(64) }).optional(),
  share: z.object({ smbName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/).optional() }).optional(),
})

// The worker's volume.create input: the owner resolved to its account name.
async function workerVolume(ctx: Context & { user: { userId: string } }, v: z.infer<typeof zVolumeInput>['volume']) {
  const { ownerUserId, access, ...rest } = v
  if (access === 'keep') return { ...rest, access: '', ownerUser: '' }
  const ownerId = access === 'user' ? ownerUserId : ctx.user.userId
  if (!ownerId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose the user who will own the volume' })
  const owner = await ctx.prisma.user.findUnique({ where: { id: ownerId }, select: { username: true } })
  if (!owner) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown user' })
  return { ...rest, access, ownerUser: owner.username }
}

// Dependencies of a create-volume plan, with today's Place and share checks.
async function volumeDeps(ctx: Context, input: z.infer<typeof zVolumeInput>, timeout: number): Promise<VolumePlanDeps> {
  const mp = input.volume.mountpoint
  if (input.place && await ctx.prisma.place.findFirst({ where: { path: mp } }))
    throw new TRPCError({ code: 'CONFLICT', message: `A Place already exists at ${mp}` })
  const placeName = input.place?.name ?? ''
  const smbName = input.share ? effectiveSmbName({ smbName: input.share.smbName ?? null }, placeName) : ''
  if (input.share) {
    const others = await ctx.prisma.share.findMany({ include: { place: { select: { name: true } } } })
    if (others.some(s => effectiveSmbName(s, s.place.name).toLowerCase() === smbName.toLowerCase()))
      throw new TRPCError({ code: 'CONFLICT', message: `Share name "${smbName}" is already in use` })
  }
  return {
    isAdmin: !!ctx.user?.isAdmin,
    worker: <T>(subject: string, payload: Record<string, unknown>) => requestSync<T>(subject, payload, timeout),
    smbdInstalled: () => requestSync<{ smbdInstalled: boolean }>('root.sharing.checkPrereqs', {}).then(r => r.smbdInstalled),
    smbSettings: () => currentSmbSettings(ctx.prisma),
    shareDefs: () => desiredShareDefs(ctx.prisma, { kind: 'create', row: {
      id: '(new)', placeId: '(new place)', smbName: input.share?.smbName ?? null, readOnly: false, guestOk: false, enabled: true, hidden: false,
      place: { name: placeName, path: mp },
    } }),
    serialize: withShareLock,
    resync: () => syncSharesBestEffort(ctx.prisma),
    // The volume's access choice (shared, user or keep) already set its root.
    createPlace: () => ctx.prisma.place.create({ data: { name: placeName, path: mp }, select: { id: true } }),
    createShare: (placeId: string) => ctx.prisma.share.create({ data: { placeId, smbName: input.share?.smbName ?? null, readOnly: false, guestOk: false } }),
  }
}

// The worker can reply null for an empty LVM list (no LVM, e.g. an LXC container).
function lvmLists(lvm: Partial<VolumeInput['lvm']>): VolumeInput['lvm'] {
  return { pvs: lvm.pvs ?? [], vgs: lvm.vgs ?? [], lvs: lvm.lvs ?? [] }
}

// Every data volume with its stack and what uses it (#40).
async function loadVolumes(ctx: Context, opts: { strict?: boolean } = {}) {
  const [block, lvm, guard, holds, places, shares, apps, zfs] = await Promise.all([
    requestSync<{ devices: VDev[]; raids: VolumeInput['raids'] }>('root.sys.blockdevices', {}, 15_000),
    requestSync<VolumeInput['lvm']>('root.sys.lvm.info', {}, 10_000).catch(() => ({ pvs: [], vgs: [], lvs: [] })),
    opts.strict ? volumeStates.get() : volumeStates.get().catch(() => []),
    ctx.prisma.volumeHold.findMany(),
    ctx.prisma.place.findMany({ select: { id: true, name: true, path: true } }),
    ctx.prisma.share.findMany({ where: { enabled: true }, include: { place: { select: { name: true } } } }),
    opts.strict ? appSources() : appSources().catch(() => []),
    loadZfs(),
  ])
  return buildVolumes({
    devices: block.devices ?? [],
    raids: block.raids ?? [],
    lvm: lvmLists(lvm),
    guard,
    holds,
    places,
    shares: shares.map(s => ({ placeId: s.placeId, name: effectiveSmbName(s, s.place.name) })),
    apps,
    zfs,
  })
}

// ZFS pools and datasets (lot 1); none when the host has no ZFS or the worker
// is older.
function loadZfs(): Promise<ZfsInfo> {
  return requestSync<ZfsInfo>('root.zfs.list', {}, 20_000).catch(() => NO_ZFS)
}

// The volume to remove and what uses it, read from the server now.
async function removeTarget(ctx: Context, id: string): Promise<RemoveTarget> {
  // Strict: an unreadable app list or volume guard must not read as "unused".
  const v = (await loadVolumes(ctx, { strict: true })).volumes.find(x => x.id === id)
  if (!v) throw new TRPCError({ code: 'NOT_FOUND', message: 'This volume is no longer on the server' })
  return removeTargetOf(v)
}

function removeDeps(ctx: Context, timeout: number): VolumeRemoveDeps {
  return {
    isAdmin: !!ctx.user?.isAdmin,
    syncAccess: () => syncPlaceAccess(ctx.prisma),
    worker: <T>(subject: string, payload: Record<string, unknown>) => requestSync<T>(subject, payload, timeout),
    smbdInstalled: () => requestSync<{ smbdInstalled: boolean }>('root.sharing.checkPrereqs', {}).then(r => r.smbdInstalled),
    smbSettings: () => currentSmbSettings(ctx.prisma),
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
      return await requestSync<{ steps: PlanStep[]; fingerprint: string }>('root.plan.preview', { op: input.op, input: workerIn }, 60_000)
    }),

  execute: storageProcedure
    .input(z.object({ op: z.enum(PLAN_OPS), input: z.unknown(), fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const workerIn = await workerInput(ctx, input.op, input.input)
      let res: PlanApplyResult
      try {
        res = await requestSync<PlanApplyResult>('root.plan.apply', { op: input.op, input: workerIn, fingerprint: input.fingerprint }, 180_000)
      } catch (e) {
        const code = (e as { code?: string }).code
        const message = e instanceof Error ? e.message : String(e)
        throw new TRPCError({ code: code === 'ESTALE' ? 'CONFLICT' : 'BAD_REQUEST', message })
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
      ctx.audit.meta = { plan: planAuditMeta('volume.create', res.steps, res.results) }
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
      ctx.audit.meta = { plan: planAuditMeta('volume.remove', res.steps, res.results) }
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
      orderBy: { createdAt: 'desc' },
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

    // Expand (#7): the ways this volume can grow, or why none applies.
    expandOptions: adminProcedure
      .input(z.object({ id: z.string().min(1).max(128) }))
      .query(async ({ ctx, input }) => {
        const [overview, lvm, block, pending] = await Promise.all([
          loadVolumes(ctx),
          requestSync<ExpandInput['lvm']>('root.sys.lvm.info', {}, 10_000),
          requestSync<{ devices: VDev[]; raids: ExpandInput['raids'] }>('root.sys.blockdevices', {}, 15_000),
          requestSync<{ expansions: PendingExpansion[] }>('root.sys.expansions', {}, 10_000),
        ])
        const v = overview.volumes.find(x => x.id === input.id)
        if (!v) throw new TRPCError({ code: 'NOT_FOUND', message: 'This volume is no longer on the server' })
        return expandOptions(v, { lvm: lvmLists(lvm), raids: block.raids ?? [], devices: (block.devices ?? []) as never, freeDisks: overview.freeDisks, expansions: pending.expansions })
      }),
    // Storage descriptions (#37), each with how the server differs from it.
    descriptions: storageProcedure.query(async () =>
      (await requestSync<{ descriptions: DescriptionStatus[] }>('root.storage.descriptions', {}, 10_000)).descriptions),
    // Expansions waiting for a reshape, or finished, or failed.
    expansions: storageProcedure.query(async () =>
      (await requestSync<{ expansions: PendingExpansion[] }>('root.sys.expansions', {}, 10_000)).expansions),
    retryExpansion: adminProcedure
      .input(z.object({ id: z.string().min(1).max(128) }))
      .mutation(async ({ ctx, input }) => {
        ctx.audit.target = input.id
        return requestSync('root.sys.expansions.retry', { uuid: input.id }, 10_000)
      }),

    list: storageProcedure.query(async () => {
      const [volumes, holds] = await Promise.all([fetchVolumes().catch(() => []), prisma.volumeHold.findMany()])
      return volumes.map(v => {
        const h = holds.find(x => x.mountPoint === v.mountPoint)
        return {
          ...v,
          hold: h ? { status: h.status as 'blocked' | 'back', reason: h.reason, since: h.since, stoppedApps: JSON.parse(h.stoppedApps) as string[], strayFiles: h.strayFiles } : null,
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
    }>('root.sys.disks', {})
  }),

  blockDevices: storageProcedure.query(async () => {
    return await requestSync<{
      devices: unknown[]
      raids: Array<{ name: string; level: string; state: string; devices: string[]; active: number; total: number }>
    }>('root.sys.blockdevices', {}, 15_000)
  }),

  // Scheduled disk checks (SMART self-tests, RAID consistency checks). The
  // schedule is run by a systemd timer, independently of the backend.
  // serverOffset: the server's clock (minutes, as getTimezoneOffset), so the
  // dashboard's calendar puts each run on the day the server runs it.
  maintenance: storageProcedure.query(async () => ({ serverOffset: new Date().getTimezoneOffset(), ...await requestSync<{
    timerInstalled: boolean
    tasks: Record<'smartShort' | 'smartLong' | 'raidCheck' | 'zfsScrub' | 'trim', {
      schedule: MaintenanceSchedule
      lastRun: string | null
      nextRun: string | null
      /** The latest attempt could start nothing; the timer tries again hourly. */
      postponed?: { at: string; reason: string } | null
      results: Array<{ device: string; serial?: string; status: 'started' | 'skipped' | 'error' | 'running' | 'passed' | 'failed'; message?: string }> | null
    }>
  }>('root.sys.maintenance.get', {}, 10_000) })),

  setMaintenance: storageProcedure
    .input(z.object({ smartShort: zMaintenanceSchedule, smartLong: zMaintenanceSchedule, raidCheck: zMaintenanceSchedule, zfsScrub: zMaintenanceSchedule.optional(), trim: zMaintenanceSchedule.optional() }))
    .mutation(async ({ input }) => requestSync('root.sys.maintenance.set', input, 10_000)),

  runMaintenanceNow: storageProcedure
    .input(z.object({ task: z.enum(['smartShort', 'smartLong', 'raidCheck', 'zfsScrub', 'trim']) }))
    .mutation(async ({ input }) => requestSync('root.sys.maintenance.runNow', input, 120_000)),
  // Import existing storage without formatting: arrays found in superblocks
  // that are not running, and volume groups with no active logical volume.
  importScan: storageProcedure.query(async () => requestSync<{
    arrays: Array<{ device: string; level: string; uuid: string; name: string; expected: number; members: string[]; missing: number; spares: number; extra: number }>
    vgs: Array<{ name: string; lvs: string[] }>
  }>('root.sys.import.scan', {}, 30_000)),

  // ZFS (lot 1): what the host has, the pools on its disks not imported, and
  // whether its memory is low for ZFS's cache.
  zfs: router({
    list: storageProcedure.query(() => loadZfs()),
    importScan: storageProcedure.query(async () => requestSync<{ pools: Array<{ name: string; guid: string; state: string; status?: string; otherHost: boolean; vdevs: ZfsVdev[] }> }>('root.zfs.import.scan', {}, 60_000)),
    memory: storageProcedure.query(() => ({ totalBytes: totalmem(), low: totalmem() < 2 * 1024 ** 3 })),
    // Snapshots (lot 4): every snapshot with the scheduled rules, and a folder of
    // one (admins only: it shows the names of every user's files).
    snapshots: storageProcedure.query(async () => requestSync<{ snapshots: ZfsSnap[]; rules: ZfsSnapRule[] }>('root.zfs.snapshots', {}, 30_000)),
    snapshotLs: adminProcedure.input(z.object({ snapshot: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}(\/[A-Za-z0-9_.:-]{1,64})*@[A-Za-z0-9_.:-]{1,128}$/), path: zSnapPath }))
      .query(async ({ input }) => requestSync<{ entries: Array<{ name: string; kind: 'dir' | 'file' | 'link' | 'dataset' | 'other'; size: number; mtime: number }>; truncated: boolean }>('root.zfs.snapshot.ls', input, 30_000)),
  }),

  // Host commands each feature needs, so the dashboard can explain a missing
  // package before an action fails.
  tools: storageProcedure.query(async () => {
    return await requestSync<{
      tools: Array<{ command: string; package: string; feature: string; available: boolean }>
    }>('root.sys.tools', {}, 5_000)
  }),

  smartInfo: storageProcedure
    .input(z.object({
      device: z.string().regex(/^[a-z][a-z0-9]+$/), // bare name only: sda, nvme0n1
      // Skip a disk in standby instead of spinning it up (list-wide health).
      noWake: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      return await requestSync('root.sys.smart', input, 15_000)
    }),

  // ── LVM ────────────────────────────────────────────────────────────────────

  lvmInfo: storageProcedure.query(async () => {
    return await requestSync<{
      pvs: Array<{ name: string; vgName: string; size: number; free: number }>
      vgs: Array<{ name: string; size: number; free: number; pvCount: number; lvCount: number }>
      lvs: Array<{ name: string; vgName: string; size: number; path: string }>
    }>('root.sys.lvm.info', {}, 10_000)
  }),
})
