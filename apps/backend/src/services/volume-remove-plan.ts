import crypto from "node:crypto"
import { TRPCError } from "@trpc/server"
import type { PlanApplyResult, PlanStep, StepResult } from "./storage-plan"
import { workerError } from "./sharing-plan"

// Remove volume (#40): one plan to review from the shares of the volume's
// Places (smb.sync, so Samba lets go of the folder before it is unmounted),
// the worker chain (volume.remove) and the deletion of those Places. Applied
// in that order; a part runs only if the previous one succeeded.

export type RemoveTarget = {
  uuid: string
  mountPoint: string
  name: string
  places: { id: string; name: string }[]
  apps: string[]
  /** One of the Places is shared over SMB. */
  shared: boolean
  /** The SMB names of those shares. */
  shareNames: string[]
}

export interface VolumeRemoveDeps {
  worker<T>(subject: string, payload: Record<string, unknown>): Promise<T>
  smbdInstalled(): Promise<boolean>
  /** Share definitions without the shares of these Places. */
  shareDefsWithout(placeIds: string[]): Promise<unknown[]>
  serialize<T>(fn: () => Promise<T>): Promise<T>
  resync(): Promise<void>
  deletePlace(id: string): Promise<void>
  releaseHold(mountPoint: string): Promise<void>
}

type Preview = { steps: PlanStep[]; fingerprint: string }

// When the smb.sync part drops the volume's shares first, the worker closes
// their open sessions before unmounting (a reload keeps them open).
const workerInput = (t: RemoveTarget, sharesDropped: boolean) =>
  (sharesDropped && t.shareNames.length ? { uuid: t.uuid, closeShares: t.shareNames } : { uuid: t.uuid })

/** The removal target of a volume of the Volumes page. */
export function removeTargetOf(v: {
  id: string; name: string; state: string; mountPoint?: string; expectedMountPoint?: string
  usedBy: { places: { id: string; name: string }[]; shares: string[]; apps: string[] }
}): RemoveTarget {
  if (v.state === "missing") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This volume is missing: its disks are not connected" })
  if (v.id.startsWith("dev:"))
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This volume has no filesystem UUID; remove it from Disks instead" })
  return {
    uuid: v.id, mountPoint: v.mountPoint ?? v.expectedMountPoint ?? "", name: v.name,
    places: v.usedBy.places, apps: v.usedBy.apps, shared: v.usedBy.shares.length > 0, shareNames: v.usedBy.shares,
  }
}

const placeStep = (p: { name: string }): PlanStep => ({ kind: "remove", target: p.name, summary: `Delete the Place "${p.name}"` })
const notRun = (n: number): StepResult[] => Array.from({ length: n }, () => ({ status: "not-run" }))

function check(t: RemoveTarget) {
  if (t.apps.length)
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${t.apps.join(", ")} ${t.apps.length === 1 ? "stores" : "store"} data on this volume: remove ${t.apps.length === 1 ? "it" : "them"} or move the data first` })
}

async function preview(deps: VolumeRemoveDeps, op: string, input: Record<string, unknown>): Promise<Preview> {
  try {
    return await deps.worker<Preview>("root.plan.preview", { op, input })
  } catch (e) { workerError(e) }
}

async function parts(t: RemoveTarget, deps: VolumeRemoveDeps) {
  let smb: (Preview & { input: Record<string, unknown> }) | null = null
  if (t.shared && await deps.smbdInstalled()) {
    const smbInput = { shares: await deps.shareDefsWithout(t.places.map(p => p.id)) }
    smb = { ...await preview(deps, "smb.sync", smbInput), input: smbInput }
  }
  const volume = await preview(deps, "volume.remove", workerInput(t, !!smb))
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ smb: smb?.fingerprint ?? null, volume: volume.fingerprint, places: t.places.map(p => p.id) }))
    .digest("hex")
  return { smb, volume, fingerprint }
}

export async function previewVolumeRemove(t: RemoveTarget, deps: VolumeRemoveDeps): Promise<Preview> {
  check(t)
  const { smb, volume, fingerprint } = await parts(t, deps)
  return { steps: [...(smb?.steps ?? []), ...volume.steps, ...t.places.map(placeStep)], fingerprint }
}

export async function applyVolumeRemove(t: RemoveTarget, fingerprint: string, deps: VolumeRemoveDeps): Promise<PlanApplyResult> {
  check(t)
  // Resync runs after the share lock is released: it takes the lock itself.
  let resync = false
  try {
    return await deps.serialize(() => run())
  } finally {
    if (resync) await deps.resync().catch(() => {})
  }

  async function run(): Promise<PlanApplyResult> {
    const { smb, volume, fingerprint: current } = await parts(t, deps)
    if (current !== fingerprint)
      throw new TRPCError({ code: "CONFLICT", message: "The server changed since this preview; review the plan again" })

    const steps = [...(smb?.steps ?? []), ...volume.steps, ...t.places.map(placeStep)]
    const results: StepResult[] = []
    const warnings: string[] = []
    const stop = (error: string): PlanApplyResult =>
      ({ ok: false, error, steps, results: [...results, ...notRun(steps.length - results.length)], warnings })

    // 1. Samba lets go of the folder.
    if (smb) {
      let res: PlanApplyResult
      try {
        res = await deps.worker<PlanApplyResult>("root.plan.apply", { op: "smb.sync", input: smb.input, fingerprint: smb.fingerprint })
      } catch (e) { workerError(e) }
      resync = true
      results.push(...res.results)
      warnings.push(...(res.warnings ?? []))
      if (!res.ok) return stop(`Sharing could not be stopped: ${res.error ?? "a step failed"}`)
    }

    // 2. The worker chain. Until it succeeds the Places stay, and Samba gets
    // their shares back.
    let vol: PlanApplyResult
    try {
      vol = await deps.worker<PlanApplyResult>("root.plan.apply", { op: "volume.remove", input: workerInput(t, !!smb), fingerprint: volume.fingerprint })
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === "ERR" || code === "ESTALE") workerError(e)
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `No answer from the host (${e instanceof Error ? e.message : String(e)}). The removal may still be running: check the Storage page before trying again.`,
      })
    }
    results.push(...vol.results)
    warnings.push(...(vol.warnings ?? []))
    if (!vol.ok) return stop(vol.error ?? "A step failed; what ran is shown above")
    resync = false

    // 3. The Places, now that their folder is gone.
    for (const p of t.places) {
      try {
        await deps.deletePlace(p.id)
        results.push({ status: "done" })
      } catch (e) {
        const error = `The disks are free, but the Place "${p.name}" could not be deleted: ${e instanceof Error ? e.message : String(e)}`
        results.push({ status: "failed", error })
        return stop(error)
      }
    }
    await deps.releaseHold(t.mountPoint).catch(() => {})
    return { ok: true, steps, results, warnings, reply: vol.reply }
  }
}
