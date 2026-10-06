import crypto from "node:crypto"
import { TRPCError } from "@trpc/server"
import type { PlanApplyResult, PlanStep, StepResult } from "./storage-plan"
import { workerError } from "./sharing-plan"

// Operation plans for user accounts (#36): the worker previews the Linux and
// Samba account commands (create) and the smb.conf and share group changes
// (delete); the HSI database is changed last, only once those ran.

export const USER_OPS = ["user.create", "user.delete"] as const
export type UserOp = typeof USER_OPS[number]

export interface UserPlanDeps {
  worker<T>(subject: string, payload: Record<string, unknown>): Promise<T>
  smbdInstalled(): Promise<boolean>
  /** Share definitions without the deleted user. */
  shareDefs(): Promise<unknown[]>
  /** Share definitions as they are now. */
  currentShareDefs(): Promise<unknown[]>
  serialize<T>(fn: () => Promise<T>): Promise<T>
  resync(): Promise<void>
  commit(): Promise<unknown>
}

export interface UserCreateInput { username: string; password: string; samba: boolean }
type Preview = { steps: PlanStep[]; fingerprint: string }

const STALE = "The server changed since this preview; review the plan again"

function createStep(username: string): PlanStep {
  return { kind: "create", target: username, summary: `Create the HSI user ${username}` }
}

function deleteStep(username: string): PlanStep {
  return {
    kind: "delete", target: username, destructive: true,
    summary: `Delete the HSI user ${username}; the Linux account and its Samba account stay on the server (see https://kittyruntime.github.io/home-server-interface/guide/manage-without-hsi/)`,
  }
}

async function preview(deps: UserPlanDeps, op: string, input: Record<string, unknown>): Promise<Preview> {
  try {
    return await deps.worker<Preview>("root.plan.preview", { op, input })
  } catch (e) { workerError(e) }
}

async function apply(deps: UserPlanDeps, op: string, input: Record<string, unknown>, fingerprint: string): Promise<PlanApplyResult> {
  try {
    return await deps.worker<PlanApplyResult>("root.plan.apply", { op, input, fingerprint })
  } catch (e) { workerError(e) }
}

export async function previewUserCreate(input: UserCreateInput, deps: UserPlanDeps): Promise<Preview> {
  const p = await preview(deps, "user.create", { ...input })
  return { steps: [...p.steps, createStep(input.username)], fingerprint: p.fingerprint }
}

export async function applyUserCreate(input: UserCreateInput, fingerprint: string, deps: UserPlanDeps): Promise<PlanApplyResult> {
  const res = await apply(deps, "user.create", { ...input }, fingerprint)
  const steps = [...res.steps, createStep(input.username)]
  if (!res.ok) return { ...res, steps, results: [...res.results, { status: "not-run" }] }
  try {
    await deps.commit()
  } catch (e) {
    // The Linux account exists (nologin, harmless; a retry reuses it): report
    // what ran so it is audited and shown, with the database error.
    const error = e instanceof Error ? e.message : String(e)
    return { ...res, ok: false, error, steps, results: [...res.results, { status: "failed", error }] }
  }
  return { ...res, steps, results: [...res.results, { status: "done" }] }
}

// The delete plan is the smb.sync plan (only when a share names the user) and
// the group.leave plan, then the database delete. Deciding on the definitions,
// not on the file, keeps unrelated drift in smb.conf out of a user deletion.
async function deletePreviews(username: string, deps: UserPlanDeps) {
  let smb: (Preview & { input: Record<string, unknown> }) | null = null
  const shares = await deps.shareDefs()
  const named = JSON.stringify(shares) !== JSON.stringify(await deps.currentShareDefs())
  if (named && await deps.smbdInstalled()) {
    const input = { shares }
    smb = { ...await preview(deps, "smb.sync", input), input }
  }
  const group = await preview(deps, "group.leave", { username })
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ smb: smb?.fingerprint ?? null, group: group.fingerprint, username }))
    .digest("hex")
  return { smb, group, fingerprint }
}

export async function previewUserDelete(username: string, deps: UserPlanDeps): Promise<Preview> {
  const { smb, group, fingerprint } = await deletePreviews(username, deps)
  return { steps: [...(smb?.steps ?? []), ...group.steps, deleteStep(username)], fingerprint }
}

export async function applyUserDelete(username: string, fingerprint: string, deps: UserPlanDeps): Promise<PlanApplyResult> {
  let resync = false
  try {
    return await deps.serialize(async () => {
      const { smb, group, fingerprint: current } = await deletePreviews(username, deps)
      if (current !== fingerprint) throw new TRPCError({ code: "CONFLICT", message: STALE })
      const steps: PlanStep[] = []
      const results: StepResult[] = []
      const warnings: string[] = []
      const parts: Array<[string, Record<string, unknown>, string]> = []
      if (smb) parts.push(["smb.sync", smb.input, smb.fingerprint])
      parts.push(["group.leave", { username }, group.fingerprint])
      for (const [op, input, fp] of parts) {
        const res = await apply(deps, op, input, fp)
        // From here smb.conf may no longer name a user the database still has.
        if (op === "smb.sync") resync = true
        steps.push(...res.steps)
        results.push(...res.results)
        warnings.push(...(res.warnings ?? []))
        if (!res.ok) {
          return { ok: false, error: res.error, steps: [...steps, deleteStep(username)], results: [...results, { status: "not-run" }], warnings }
        }
      }
      try {
        await deps.commit()
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        return { ok: false, error, steps: [...steps, deleteStep(username)], results: [...results, { status: "failed", error }], warnings }
      }
      resync = false
      return { ok: true, steps: [...steps, deleteStep(username)], results: [...results, { status: "done" }], warnings }
    })
  } finally {
    // smb.conf may no longer name a user the database still has.
    if (resync) await deps.resync().catch(() => {})
  }
}
