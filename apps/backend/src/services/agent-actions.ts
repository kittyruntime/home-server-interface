import { TRPCError } from "@trpc/server"
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

// Replacing a file is approved on its whole new content, which the dashboard
// shows in full: longer content cannot be queued.
export const MAX_OVERWRITE_CHARS = 20_000

type Stat = { type: string; size: number | null; mtime: string; ctime: string; uid: number }

/**
 * What a file or folder is, as far as an approval goes: a rename puts a
 * different object at a path with another ctime, so the approved deletion or
 * overwrite cannot land on something else.
 */
export function fileSignature(s: Stat): string {
  return [s.type, s.size ?? "", s.mtime, s.ctime, s.uid].join("|")
}

async function assertUnchanged(caller: Caller, expected: Array<{ path: string; sig: string }>) {
  for (const { path, sig } of expected) {
    let now: string
    try {
      now = fileSignature(await caller.fs.stat({ path }))
    } catch {
      throw new TRPCError({ code: "CONFLICT", message: `${path} is gone since the request`, cause: { code: "ESTALE" } })
    }
    if (now !== sig) throw new TRPCError({ code: "CONFLICT", message: `${path} changed since the request: nothing was done`, cause: { code: "ESTALE" } })
  }
}

export const APPROVAL_PROCEDURES: Record<string, Runner> = {
  // Every path is checked before the first is deleted.
  "fs.delete": async (caller, input: { paths: string[]; expect: Array<{ path: string; sig: string }> }) => {
    const paths = input.paths.slice(0, MAX_DELETE_PATHS)
    await assertUnchanged(caller, input.expect.filter(e => paths.includes(e.path)))
    if (input.expect.length !== paths.length) throw new TRPCError({ code: "BAD_REQUEST", message: "A path has no recorded state" })
    const jobs: Array<{ path: string; jobId: string }> = []
    for (const path of paths) jobs.push({ path, ...(await caller.fs.delete({ path })) })
    return { jobs }
  },
  "fs.writeText": async (caller, input: { path: string; content: string; sig: string }) => {
    await assertUnchanged(caller, [{ path: input.path, sig: input.sig }])
    return caller.fs.writeText({ path: input.path, content: input.content })
  },
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
