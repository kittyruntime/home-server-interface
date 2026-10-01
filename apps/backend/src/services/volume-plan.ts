import crypto from "node:crypto"
import { TRPCError } from "@trpc/server"
import type { PlanApplyResult, PlanStep, StepResult } from "./storage-plan"
import { workerError } from "./sharing-plan"

// Create volume (#40): one plan to review from the worker chain
// (volume.create), a Place on the new folder, and an SMB share of it. Applied
// in that order; a part runs only if the previous one succeeded.

export type VolumeInput = {
  volume: Record<string, unknown> & { mountpoint: string }
  place?: { name: string }
  share?: { smbName?: string }
}

export interface VolumePlanDeps {
  isAdmin: boolean
  worker<T>(subject: string, payload: Record<string, unknown>): Promise<T>
  smbdInstalled(): Promise<boolean>
  /** Share definitions with the new share (on the new Place) overlaid. */
  shareDefs(): Promise<unknown[]>
  serialize<T>(fn: () => Promise<T>): Promise<T>
  resync(): Promise<void>
  createPlace(): Promise<{ id: string }>
  createShare(placeId: string): Promise<unknown>
}

type Preview = { steps: PlanStep[]; fingerprint: string }

function placeStep(input: VolumeInput): PlanStep {
  return { kind: "create", target: input.place!.name, summary: `Create the Place "${input.place!.name}" on ${input.volume.mountpoint}` }
}

function check(input: VolumeInput, deps: VolumePlanDeps) {
  if ((input.place || input.share) && !deps.isAdmin)
    throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can create a Place or a share" })
  if (input.share && !input.place)
    throw new TRPCError({ code: "BAD_REQUEST", message: "A share needs a Place: create the Place too" })
}

async function preview(deps: VolumePlanDeps, op: string, input: Record<string, unknown>): Promise<Preview> {
  try {
    return await deps.worker<Preview>("root.plan.preview", { op, input })
  } catch (e) { workerError(e) }
}

async function parts(input: VolumeInput, deps: VolumePlanDeps) {
  const volume = await preview(deps, "volume.create", input.volume)
  let smb: (Preview & { input: Record<string, unknown> }) | null = null
  if (input.share) {
    if (!await deps.smbdInstalled())
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Samba is not installed on the host. Run: apt install samba" })
    const smbInput = { shares: await deps.shareDefs() }
    smb = { ...await preview(deps, "smb.sync", smbInput), input: smbInput }
  }
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ volume: volume.fingerprint, smb: smb?.fingerprint ?? null, place: input.place ?? null, share: input.share ?? null }))
    .digest("hex")
  return { volume, smb, fingerprint }
}

export async function previewVolume(input: VolumeInput, deps: VolumePlanDeps): Promise<Preview> {
  check(input, deps)
  const { volume, smb, fingerprint } = await parts(input, deps)
  return {
    steps: [...volume.steps, ...(input.place ? [placeStep(input)] : []), ...(smb?.steps ?? [])],
    fingerprint,
  }
}

export async function applyVolume(input: VolumeInput, fingerprint: string, deps: VolumePlanDeps): Promise<PlanApplyResult> {
  check(input, deps)
  const { volume, smb, fingerprint: current } = await parts(input, deps)
  if (current !== fingerprint)
    throw new TRPCError({ code: "CONFLICT", message: "The server changed since this preview; review the plan again" })

  const later: PlanStep[] = [...(input.place ? [placeStep(input)] : []), ...(smb?.steps ?? [])]
  const notRun = (n: number): StepResult[] => Array.from({ length: n }, () => ({ status: "not-run" }))

  let vol: PlanApplyResult
  try {
    vol = await deps.worker<PlanApplyResult>("root.plan.apply", { op: "volume.create", input: input.volume, fingerprint: volume.fingerprint })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === "ERR" || code === "ESTALE" || code === "SMBD_MISSING") workerError(e)
    // No answer: the chain may be running on the host right now.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `No answer from the host (${e instanceof Error ? e.message : String(e)}). The volume creation may still be running: check the Storage page before trying again.`,
    })
  }
  const steps = [...vol.steps, ...later]
  if (!vol.ok) return { ...vol, steps, results: [...vol.results, ...notRun(later.length)] }

  const results: StepResult[] = [...vol.results]
  const warnings = [...(vol.warnings ?? [])]
  if (!input.place) return { ok: true, steps, results, warnings, reply: vol.reply }

  let placeId: string
  try {
    placeId = (await deps.createPlace()).id
    results.push({ status: "done" })
  } catch (e) {
    const error = `The volume is ready, but the Place could not be created: ${e instanceof Error ? e.message : String(e)}`
    return { ok: false, error, steps, results: [...results, { status: "failed", error }, ...notRun(smb?.steps.length ?? 0)], warnings, reply: vol.reply }
  }
  const reply = { ...(vol.reply ?? {}), placeId }
  if (!smb) return { ok: true, steps, results, warnings, reply }

  // The share: its smb.sync plan, then its row, under the share lock. The
  // disks are erased by now, so a failure here is a partial result, never an
  // error that reads as "nothing happened".
  const sharingFailed = (why: string): PlanApplyResult => {
    const error = `The volume and its Place are ready, but sharing failed: ${why}`
    const done = results.slice(0, steps.length)
    const missing = steps.length - done.length
    const tail: StepResult[] = missing > 0 ? [{ status: "failed", error }, ...notRun(missing - 1)] : []
    return { ok: false, error, steps, results: [...done, ...tail], warnings, reply }
  }
  let resync = false
  try {
    return await deps.serialize(async () => {
      let res: PlanApplyResult
      try {
        res = await deps.worker<PlanApplyResult>("root.plan.apply", { op: "smb.sync", input: smb.input, fingerprint: smb.fingerprint })
      } catch (e) {
        return sharingFailed(e instanceof Error ? e.message : String(e))
      }
      resync = true
      results.push(...res.results)
      warnings.push(...(res.warnings ?? []))
      if (!res.ok) return sharingFailed(res.error ?? "a step failed")
      try {
        await deps.createShare(placeId)
      } catch (e) {
        return sharingFailed(e instanceof Error ? e.message : String(e))
      }
      resync = false
      return { ok: true, steps, results, warnings, reply }
    })
  } finally {
    if (resync) await deps.resync().catch(() => {})
  }
}
