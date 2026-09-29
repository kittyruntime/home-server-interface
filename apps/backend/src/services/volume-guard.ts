import { TRPCError } from "@trpc/server"
import { prisma } from "@app/database"
import { composeBindSources } from "@app/compose"
import { requestSync, publishJob } from "../nats"
import { log } from "../utils/log"
import { scanStacks } from "./containerStacks"
import { reconcileSource } from "./alert-sampler"

// Missing volume guard (#3). The worker reports the state of each HSI data
// volume; one that is not usable gets a hold: apps using it are stopped, its
// shares become unavailable, and backups and file writes under it are refused.
// When it is usable again the hold waits for the admin to resume.

export type VolumeState = "ok" | "missing" | "wrong" | "readonly"
type Hold = { mountPoint: string; status: string; reason: string }

export function pathUnder(path: string, mountPoint: string): boolean {
  return path === mountPoint || path.startsWith(mountPoint.replace(/\/$/, "") + "/")
}

export function holdFor<T extends Hold>(holds: T[], path: string): T | null {
  let best: T | null = null
  for (const h of holds) {
    if (pathUnder(path, h.mountPoint) && (!best || h.mountPoint.length > best.mountPoint.length)) best = h
  }
  return best
}

export function holdMessage(h: Hold): string {
  const state = h.status === "back" ? "waiting for confirmation" : h.reason
  return `Volume ${h.mountPoint} is ${state}; resume it in Storage first`
}

export function planHolds(volumes: Array<{ mountPoint: string; state: string }>, holds: Hold[]) {
  const byMp = new Map(holds.map(h => [h.mountPoint, h]))
  const create: Array<{ mountPoint: string; reason: string }> = []
  const back: string[] = []
  const reblock: Array<{ mountPoint: string; reason: string }> = []
  for (const v of volumes) {
    const h = byMp.get(v.mountPoint)
    if (v.state !== "ok" && !h) create.push({ mountPoint: v.mountPoint, reason: v.state })
    else if (v.state === "ok" && h?.status === "blocked") back.push(v.mountPoint)
    else if (v.state !== "ok" && h?.status === "back") reblock.push({ mountPoint: v.mountPoint, reason: v.state })
  }
  return { create, back, reblock }
}

export function appsUnder(apps: Array<{ name: string; sources: string[] }>, mountPoint: string): string[] {
  return apps.filter(a => a.sources.some(s => pathUnder(s, mountPoint))).map(a => a.name)
}

// Only local paths count: the remote side of a backup lives on another host.
export function backupLocalPaths(plan: { direction: string; source: string; destination: string; remoteHost: string | null }): string[] {
  if (!plan.remoteHost) return [plan.source, plan.destination]
  return plan.direction === "pull" ? [plan.destination] : [plan.source]
}

const ALERT_MESSAGES: Record<string, string> = {
  missing: "Volume is not mounted",
  wrong: "Another filesystem is mounted in place of the volume",
  readonly: "Volume is mounted read-only",
}

export function volumeFindings(volumes: Array<{ mountPoint: string; state: string }>) {
  return {
    checked: volumes.map(v => v.mountPoint),
    found: volumes.filter(v => v.state !== "ok").map(v => ({
      target: v.mountPoint,
      severity: (v.state === "readonly" ? "warning" : "critical") as "warning" | "critical",
      message: ALERT_MESSAGES[v.state] ?? v.state,
    })),
  }
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export type WorkerVolume = { mountPoint: string; uuid: string; state: VolumeState; strayFiles: boolean; guardError?: string }

export async function fetchVolumes(): Promise<WorkerVolume[]> {
  const res = await requestSync<{ volumes: WorkerVolume[] }>("root.storage.volumes", {}, 30_000)
  return res.volumes
}

async function appSources(): Promise<Array<{ name: string; sources: string[] }>> {
  const stacks = await scanStacks()
  return stacks.map(s => ({ name: s.name, sources: composeBindSources(s.content) }))
}

// Loaded lazily: sharing.service imports this module for holdFor.
async function syncShares(): Promise<void> {
  const { syncSharesBestEffort } = await import("./sharing.service")
  await syncSharesBestEffort(prisma)
}

let running = false

export async function runVolumeGuard(): Promise<void> {
  if (running) return
  running = true
  try {
    const volumes = await fetchVolumes()
    await reconcileSource("storage.volume", volumeFindings(volumes))
    const holds = await prisma.volumeHold.findMany()
    const plan = planHolds(volumes, holds)
    if (plan.create.length > 0) {
      const apps = await appSources().catch(() => [])
      for (const c of plan.create) {
        const stopped = appsUnder(apps, c.mountPoint)
        const stray = volumes.find(v => v.mountPoint === c.mountPoint)?.strayFiles ?? false
        await prisma.volumeHold.create({ data: { mountPoint: c.mountPoint, reason: c.reason, status: "blocked", stoppedApps: JSON.stringify(stopped), strayFiles: stray } })
        for (const name of stopped) {
          await publishJob("container.composeStop", { name }).catch(e => log.warn({ err: e, app: name }, "volume-guard: could not stop app"))
        }
        log.warn({ mountPoint: c.mountPoint, reason: c.reason, stopped }, "volume-guard: volume blocked")
      }
      await syncShares()
    }
    for (const mp of plan.back) {
      await prisma.volumeHold.update({ where: { mountPoint: mp }, data: { status: "back" } })
      log.info({ mountPoint: mp }, "volume-guard: volume is back, waiting for the admin")
    }
    for (const r of plan.reblock) {
      await prisma.volumeHold.update({ where: { mountPoint: r.mountPoint }, data: { status: "blocked", reason: r.reason } })
    }
  } catch (e) {
    log.warn({ err: e }, "volume-guard: check failed")
  } finally {
    running = false
  }
}

export function startVolumeGuard(): void {
  void runVolumeGuard()
  setInterval(() => { void runVolumeGuard() }, 60_000).unref()
}

export async function assertVolumeAvailable(paths: string | string[]): Promise<void> {
  const list = Array.isArray(paths) ? paths : [paths]
  if (list.length === 0) return
  const holds = await prisma.volumeHold.findMany()
  for (const p of list) {
    const h = holdFor(holds, p)
    if (h) throw new TRPCError({ code: "PRECONDITION_FAILED", message: holdMessage(h) })
  }
}

export async function resumeVolume(mountPoint: string): Promise<{ restarted: string[] }> {
  const hold = await prisma.volumeHold.findUnique({ where: { mountPoint } })
  if (!hold) throw new TRPCError({ code: "NOT_FOUND", message: "No hold for this volume" })
  if (hold.status !== "back") throw new TRPCError({ code: "PRECONDITION_FAILED", message: holdMessage(hold) })
  await prisma.volumeHold.delete({ where: { mountPoint } })
  const apps: string[] = JSON.parse(hold.stoppedApps)
  for (const name of apps) {
    await publishJob("container.composeUp", { name }).catch(e => log.warn({ err: e, app: name }, "volume-guard: could not restart app"))
  }
  await syncShares()
  log.info({ mountPoint, restarted: apps }, "volume-guard: volume resumed")
  return { restarted: apps }
}
