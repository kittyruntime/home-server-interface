import type { PrismaClient } from "@app/database"
import { isIP } from "node:net"
import { requestSync } from "../nats"

// SMB service settings, the connection journal pulled from the root worker,
// its 30-day retention and the automatic blocking of addresses that keep
// failing to sign in.

export const SMB_EVENT_RETENTION_DAYS = 30
const DAY_MS = 86_400_000

export type SmbSettingsPatch = Partial<{
  netbiosName: string
  workgroup: string
  minProtocol: "SMB2" | "SMB3"
  encryption: "off" | "desired" | "required"
  discoveryWsd: boolean
  discoveryMdns: boolean
  autoBlock: boolean
  blockThreshold: number
  blockWindowMin: number
  blockForMin: number
}>

/** What the worker's smb.conf rendering takes (root.sharing.sync `settings`). */
export interface WorkerSmbSettings {
  netbiosName: string
  workgroup: string
  minProtocol: string
  encryption: string
  hostsDeny: string[]
  audit: boolean
}

type Db = PrismaClient

export async function getSmbSettings(prisma: Db) {
  return prisma.smbSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} })
}

/** The settings part of an smb.sync input, with a planned change applied. */
export async function workerSmbSettings(
  prisma: Db,
  o: { audit: boolean; now?: Date; patch?: SmbSettingsPatch },
): Promise<WorkerSmbSettings> {
  const s = { ...await getSmbSettings(prisma), ...o.patch }
  const blocks = await prisma.smbBlock.findMany({ where: { until: { gt: o.now ?? new Date() } } })
  return {
    netbiosName: s.netbiosName,
    workgroup: s.workgroup,
    minProtocol: s.minProtocol,
    encryption: s.encryption,
    hostsDeny: blocks.map(b => b.ip).sort(),
    audit: o.audit,
  }
}

export interface SmbServiceState {
  installed: boolean
  active: boolean
  version: string
  audit: boolean
  wsdd: string
  avahi: boolean
  wsddOn: boolean
  avahiOn: boolean
}

export function smbServiceState(): Promise<SmbServiceState> {
  return requestSync<SmbServiceState>("root.sharing.service", {})
}

// Whether this Samba can write the journal changes with a package upgrade,
// not between two syncs: asked once per backend run, again after a failure.
let auditSupport: Promise<boolean> | null = null
export function smbAuditSupported(): Promise<boolean> {
  auditSupport ??= smbServiceState().then(s => s.installed && s.audit).catch(() => {
    auditSupport = null
    return false
  })
  return auditSupport
}

type WorkerCall = <T>(subject: string, payload: Record<string, unknown>) => Promise<T>

interface WorkerEvent {
  at: string; kind: string; result: string
  reason?: string; user?: string; ip?: string; machine?: string; share?: string
}

/** Stores the journal lines the worker read since the stored cursor. */
export async function pullSmbEvents(prisma: Db, worker: WorkerCall = requestSync): Promise<number> {
  const settings = await getSmbSettings(prisma)
  const cursor = settings.eventCursor ? JSON.parse(settings.eventCursor) : undefined
  const res = await worker<{ available: boolean; cursor: unknown; events: WorkerEvent[] }>(
    "root.sharing.events", cursor ? { cursor } : {})
  if (!res.available) return 0
  if (res.events.length > 0) {
    await prisma.shareEvent.createMany({
      data: res.events.map(e => ({
        at: new Date(e.at), kind: e.kind, result: e.result,
        reason: e.reason ?? "", user: e.user ?? "", ip: e.ip ?? "", machine: e.machine ?? "", share: e.share ?? "",
      })),
    })
  }
  await prisma.smbSettings.update({ where: { id: 1 }, data: { eventCursor: JSON.stringify(res.cursor) } })
  return res.events.length
}

export async function pruneSmbEvents(prisma: Db, now = new Date()): Promise<void> {
  await prisma.shareEvent.deleteMany({ where: { at: { lt: new Date(now.getTime() - SMB_EVENT_RETENTION_DAYS * DAY_MS) } } })
  await prisma.smbBlock.deleteMany({ where: { until: { lte: now } } })
}

/** Removes blocks whose time is over; true when Samba must be resynced. */
export async function expireSmbBlocks(prisma: Db, now = new Date()): Promise<boolean> {
  const { count } = await prisma.smbBlock.deleteMany({ where: { until: { lte: now } } })
  return count > 0
}

function normalizeIp(ip: string): string {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip
  return isIP(v4) ? v4 : ""
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.")
}

/** Blocks the addresses with too many refusals in the window; returns the
 *  ones newly blocked. Loopback is never blocked. */
export async function applyAutoBlock(prisma: Db, now = new Date()): Promise<string[]> {
  const s = await getSmbSettings(prisma)
  if (!s.autoBlock) return []
  const since = new Date(now.getTime() - s.blockWindowMin * 60_000)
  const refused = await prisma.shareEvent.findMany({ where: { result: "refused", at: { gte: since } }, select: { ip: true } })
  const counts = new Map<string, number>()
  for (const e of refused) {
    const ip = normalizeIp(e.ip)
    if (ip && !isLoopback(ip)) counts.set(ip, (counts.get(ip) ?? 0) + 1)
  }
  const active = new Set((await prisma.smbBlock.findMany({ where: { until: { gt: now } } })).map(b => b.ip))
  const until = new Date(now.getTime() + s.blockForMin * 60_000)
  const blocked: string[] = []
  for (const [ip, n] of [...counts].sort()) {
    if (n < s.blockThreshold || active.has(ip)) continue
    await prisma.smbBlock.upsert({ where: { ip }, create: { ip, until, reason: "auto" }, update: { until, reason: "auto" } })
    blocked.push(ip)
  }
  return blocked
}

/** Active blocks, the caller's own address marked so the admin sees they
 *  locked themselves out of SMB. */
export async function listBlocks(prisma: Db, callerIp: string | undefined, now = new Date()) {
  const mine = normalizeIp(callerIp ?? "")
  const rows = await prisma.smbBlock.findMany({ where: { until: { gt: now } } })
  return rows
    .map(b => ({ ip: b.ip, until: b.until, reason: b.reason, mine: b.ip === mine }))
    .sort((a, b) => a.ip.localeCompare(b.ip))
}

const PULL_EVERY_MS = 5_000
const PRUNE_EVERY_MS = 60 * 60 * 1000

/** Pulls the journal every few seconds while the backend runs, blocks
 *  repeated refusals and lifts expired blocks, resyncing Samba when the
 *  blocked list changes. */
export function startSmbJournal(prisma: Db, resync: () => Promise<void>, log: { warn: (o: Record<string, unknown>, m: string) => void }): void {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      let changed = await expireSmbBlocks(prisma)
      if (await smbAuditSupported()) {
        if (await pullSmbEvents(prisma) > 0) changed = (await applyAutoBlock(prisma)).length > 0 || changed
      }
      if (changed) await resync()
    } catch (e) {
      log.warn({ err: e }, "smb journal: pull failed")
    } finally {
      busy = false
    }
  }
  setInterval(() => { void tick() }, PULL_EVERY_MS).unref()
  setInterval(() => { void pruneSmbEvents(prisma).catch(() => {}) }, PRUNE_EVERY_MS).unref()
}
