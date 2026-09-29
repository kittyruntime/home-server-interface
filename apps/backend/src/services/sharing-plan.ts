import { TRPCError } from "@trpc/server"
import type { PlanApplyResult, PlanStep } from "./storage-plan"

// Operation plans for Samba shares (#36): the worker previews smb.conf and the
// smbd reload for the share definitions as they will be after the change; the
// database row is written only once that plan ran.

export const SHARE_OPS = ["share.create", "share.update", "share.remove"] as const
export type ShareOp = typeof SHARE_OPS[number]

export interface ShareRow { id: string; placeId: string; smbName: string | null; readOnly: boolean; guestOk: boolean; enabled: boolean; place: { name: string; path: string } }
export type ShareChange =
  | { kind: "create"; row: ShareRow }
  | { kind: "update"; id: string; patch: Partial<Pick<ShareRow, "enabled" | "readOnly" | "guestOk" | "smbName">> }
  | { kind: "remove"; id: string }

export function overlayShares(rows: ShareRow[], change?: ShareChange): ShareRow[] {
  if (!change) return rows
  switch (change.kind) {
    case "create": return [...rows, change.row]
    case "update": return rows.map(r => (r.id === change.id ? { ...r, ...change.patch } : r))
    case "remove": return rows.filter(r => r.id !== change.id)
  }
}

export interface SharePlanDeps {
  smbdInstalled(): Promise<boolean>
  defs(): Promise<unknown[]>
  worker<T>(subject: string, payload: Record<string, unknown>): Promise<T>
  commit(): Promise<unknown>
}

export const NO_SAMBA_FINGERPRINT = "no-samba"
const SAMBA_MISSING = "Samba is not installed on the host. Run: apt install samba"

function noSambaRemoval(name: string): PlanStep {
  return { kind: "delete", target: name, summary: `Samba is not installed; only HSI's record of the share ${name} is removed` }
}

function workerError(e: unknown): never {
  const code = (e as { code?: string }).code
  const message = e instanceof Error ? e.message : String(e)
  if (code === "SMBD_MISSING") throw new TRPCError({ code: "PRECONDITION_FAILED", message: SAMBA_MISSING })
  throw new TRPCError({ code: code === "ESTALE" ? "CONFLICT" : "BAD_REQUEST", message })
}

export async function previewShareChange(op: ShareOp, name: string, deps: SharePlanDeps): Promise<{ steps: PlanStep[]; fingerprint: string }> {
  if (!await deps.smbdInstalled()) {
    if (op !== "share.remove") throw new TRPCError({ code: "PRECONDITION_FAILED", message: SAMBA_MISSING })
    return { steps: [noSambaRemoval(name)], fingerprint: NO_SAMBA_FINGERPRINT }
  }
  try {
    return await deps.worker("root.plan.preview", { op: "smb.sync", input: { shares: await deps.defs() } })
  } catch (e) { workerError(e) }
}

export async function applyShareChange(op: ShareOp, name: string, fingerprint: string, deps: SharePlanDeps): Promise<PlanApplyResult> {
  if (fingerprint === NO_SAMBA_FINGERPRINT) {
    if (op !== "share.remove" || await deps.smbdInstalled()) {
      throw new TRPCError({ code: "CONFLICT", message: "The server changed since this preview; review the plan again" })
    }
    await deps.commit()
    return { ok: true, steps: [noSambaRemoval(name)], results: [{ status: "done" }] }
  }
  let res: PlanApplyResult
  try {
    res = await deps.worker<PlanApplyResult>("root.plan.apply", { op: "smb.sync", input: { shares: await deps.defs() }, fingerprint })
  } catch (e) { workerError(e) }
  if (res.ok) await deps.commit()
  return res
}
