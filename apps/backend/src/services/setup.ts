import { TRPCError } from "@trpc/server"
import { signSetupSession, verifySetupSession } from "../trpc/auth"
import { assertNotThrottled, clearLoginFailures, recordLoginFailure } from "./login-throttle"

// First-run setup (#12). Setup is required while no administrator exists; the
// one-time token printed by the installer opens a short setup session that can
// create one. Progress is kept so a reload or a reboot resumes there.

export const SETUP_STEPS = ["admin", "identity", "next", "done"] as const
export type SetupStep = typeof SETUP_STEPS[number]

export interface SetupDeps {
  adminCount(): Promise<number>
  workerVerify(token: string): Promise<boolean>
  getState(): Promise<{ step: string; skipped: string[] } | null>
  setState(step: SetupStep, skipped: string[]): Promise<void>
}

/** `viewer` is the signed-in account, if any: only an admin resumes the assistant. */
export async function setupStatus(d: SetupDeps, viewer?: { isAdmin: boolean } | null): Promise<{ required: boolean; step: SetupStep | null }> {
  const required = await d.adminCount() === 0
  if (required) return { required, step: "admin" }
  if (!viewer?.isAdmin) return { required, step: null }
  const state = await d.getState()
  const step = state && (SETUP_STEPS as readonly string[]).includes(state.step) && state.step !== "done" ? state.step as SetupStep : null
  return { required, step }
}

/** The setup session for a valid token; throttled per address like the login. */
export async function checkSetupToken(d: SetupDeps, token: string, ip: string): Promise<string> {
  if (await d.adminCount() > 0) throw new TRPCError({ code: "FORBIDDEN", message: "Setup is already done: sign in instead" })
  const keys = [`setup:${ip}`]
  assertNotThrottled(keys)
  if (!await d.workerVerify(token)) {
    recordLoginFailure(keys)
    throw new TRPCError({ code: "UNAUTHORIZED", message: "This setup link is not valid. Run `sudo hsi-worker setup-token` on the server for a new one." })
  }
  clearLoginFailures(keys)
  return signSetupSession()
}

export async function recordProgress(d: SetupDeps, step: SetupStep, skip?: string): Promise<void> {
  if (!(SETUP_STEPS as readonly string[]).includes(step)) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown setup step ${step}` })
  const skipped = (await d.getState())?.skipped ?? []
  await d.setState(step, skip && !skipped.includes(skip) ? [...skipped, skip] : skipped)
}

// One administrator creation at a time in this process: the check and the
// creation (useradd, smbpasswd, bcrypt) take seconds, and two setup sessions
// open at once must not both pass the check.
let creating: Promise<unknown> = Promise.resolve()

/**
 * Creates the first administrator with a setup session. `create` makes the
 * account (Linux, Samba, HSI user) already flagged admin.
 */
export async function createFirstAdmin<U extends { id: string; username: string }>(
  d: SetupDeps,
  create: (input: { username: string; password: string }) => Promise<U>,
  setupToken: string,
  input: { username: string; password: string },
): Promise<U> {
  try { verifySetupSession(setupToken) } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "The setup session expired: open the setup link again" })
  }
  const run = creating.then(async () => {
    if (await d.adminCount() > 0) throw new TRPCError({ code: "FORBIDDEN", message: "Setup is already done: sign in instead" })
    const user = await create(input)
    await d.setState("identity", [])
    return user
  })
  creating = run.catch(() => {})
  return run
}
