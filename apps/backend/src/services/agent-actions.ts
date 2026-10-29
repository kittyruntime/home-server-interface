import type { Caller } from "../mcp/tools"

// Changes an AI assistant asks for that wait for a person (#138). The
// assistant gets an action id; its user approves or rejects it in the
// dashboard, and only then is the stored call run, as that user. Only the
// procedures below can be queued: an action names one and its input, nothing
// else runs.

export const ACTION_TTL_MS = 24 * 60 * 60 * 1000

export type ActionStatus = "pending" | "approved" | "done" | "failed" | "rejected" | "expired"

type Runner = (caller: Caller, input: any) => Promise<unknown>

// Deleting files is capped per action, so one approval never empties a disk
// by surprise.
export const MAX_DELETE_PATHS = 20

export const APPROVAL_PROCEDURES: Record<string, Runner> = {
  "fs.delete": async (caller, input: { paths: string[] }) => {
    const jobs: Array<{ path: string; jobId: string }> = []
    for (const path of input.paths.slice(0, MAX_DELETE_PATHS)) jobs.push({ path, ...(await caller.fs.delete({ path })) })
    return { jobs }
  },
  "fs.writeText": (caller, input) => caller.fs.writeText(input),
  "storage.execute": (caller, input) => caller.storage.execute(input),
  "apps.execute": (caller, input) => caller.apps.execute(input),
  "user.execute": (caller, input) => caller.user.execute(input),
  "sharing.execute": (caller, input) => caller.sharing.execute(input),
  "permission.upsert": (caller, input) => caller.permission.upsert(input),
  "permission.remove": (caller, input) => caller.permission.remove(input),
  "update.execute": (caller, input) => caller.update.execute(input),
}

export function isQueueable(procedure: string): boolean {
  return Object.hasOwn(APPROVAL_PROCEDURES, procedure)
}

/** Whether an action may still be decided on. */
export function decidable(a: { status: string; expiresAt: Date }, now = new Date()): boolean {
  return a.status === "pending" && a.expiresAt > now
}

/**
 * A plan executed with a failed step comes back as { ok: false }: the action
 * then failed, though the call itself did not throw.
 */
export function outcome(result: unknown): { ok: boolean; error?: string } {
  if (result && typeof result === "object" && "ok" in result && (result as { ok: unknown }).ok === false) {
    return { ok: false, error: String((result as { error?: unknown }).error ?? "A step of the plan failed") }
  }
  return { ok: true }
}
