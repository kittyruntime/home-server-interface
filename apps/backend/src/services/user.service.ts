import bcrypt from "bcryptjs"
import { TRPCError } from "@trpc/server"
import type { PrismaClient } from "@app/database"
import { requestSync } from "../nats"

// System account names that may never be claimed as an HSI username, since
// the username doubles as the backing Linux/Samba account. "admin" is
// deliberately excluded — it's a valid (and commonly used) HSI username.
export const RESERVED_USERNAMES = new Set(["root", "daemon", "bin", "sys", "nobody", "www-data"])

export const userSelect = {
  id: true,
  username: true,
  displayName: true,
  isAdmin: true,
  isUserManager: true,
  sambaEnabled: true,
  createdAt: true,
  capabilities: { select: { capability: true } },
} as const

// A username must be a valid Linux account name so it can back the user's
// Linux + Samba (SMB) account. Enforced at the API boundary (user.create).
export const reLinuxUsername = /^[a-z_][a-z0-9_-]{0,31}$/

export async function createUser(
  prisma: PrismaClient,
  input: { username: string; password: string; displayName?: string },
) {
  if (RESERVED_USERNAMES.has(input.username))
    throw new TRPCError({ code: "BAD_REQUEST", message: "That username is reserved" })

  const existing = await prisma.user.findUnique({ where: { username: input.username } })
  if (existing) throw new TRPCError({ code: "CONFLICT", message: "Username already taken" })

  const hashedPassword = await bcrypt.hash(input.password, 12)

  const user = await prisma.user.create({
    data: {
      username: input.username,
      password: hashedPassword,
      displayName: input.displayName ?? null,
    },
    select: userSelect,
  })

  // Provisions the backing Linux/Samba account (idempotent) and sets its
  // password. syncSystemPassword is self-contained best-effort, so a worker
  // hiccup here never fails user creation.
  if (reLinuxUsername.test(input.username)) {
    await syncSystemPassword(prisma, user.id, input.password)
  }

  return user
}

export async function changePassword(
  prisma: PrismaClient,
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { password: true },
  })
  if (!(await bcrypt.compare(currentPassword, user.password)))
    throw new TRPCError({ code: "FORBIDDEN", message: "Current password is incorrect" })
  const newHashed = await bcrypt.hash(newPassword, 12)
  const result = await prisma.user.update({
    where: { id: userId },
    // A changed password can never leave mustChangePassword set — that flag only
    // ever means "still on the value it was created with".
    data: { password: newHashed, mustChangePassword: false },
    select: { id: true, username: true },
  })
  void syncSystemPassword(prisma, userId, newPassword)
  return result
}

/** NAS-style single password: pushes the plaintext to the root-worker which
 *  sets it on the Linux account (chpasswd — shell stays /sbin/nologin, no
 *  login access) and the Samba account (smbpasswd). Called at the only
 *  moments plaintext exists: user creation, password change, and login
 *  (login backfills accounts that predate this feature). Best-effort by
 *  design — a sync failure must never break the calling flow. */
export async function syncSystemPassword(
  prisma: PrismaClient,
  userId: string,
  plainPassword: string,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, sambaEnabled: true },
    })
    if (!user?.username) return
    // Ensure the backing Linux account exists before setting its password. The
    // username IS the Linux/Samba account, but the account may not exist yet —
    // e.g. the seeded `admin`, or any user whose row predates this identity
    // model. chpasswd/smbpasswd both require an existing Unix account, so
    // create it first. The worker's create is idempotent (useradd exit 9 =
    // already exists → treated as success).
    if (reLinuxUsername.test(user.username)) {
      await requestSync("root.linux.user.create", { username: user.username })
    }
    const res = await requestSync<{ linuxOk?: boolean; smbOk?: boolean; smbSkipped?: boolean }>(
      "root.sharing.setPassword",
      { linuxUsername: user.username, password: plainPassword, skipSamba: !user.sambaEnabled },
    )
    // The worker replies ok even when a sub-step fails (best-effort). Surface a
    // partial failure so "can't connect to SMB" is diagnosable from the logs
    // instead of silent — the most common cause of Samba auth being refused.
    // Skipped-by-choice (sambaEnabled=false) is not a failure — don't warn on it.
    if (res?.smbOk === false && !res.smbSkipped) {
      console.warn(
        `[password-sync] Samba password NOT set for "${user.username}" — ` +
          `smbpasswd failed (is samba installed, and does the Linux account exist?). ` +
          `SMB auth will be refused for this user until this succeeds.`,
      )
    }
    if (res?.linuxOk === false) {
      console.warn(`[password-sync] Linux password NOT set for "${user.username}" — chpasswd failed.`)
    }
  } catch (e) {
    console.warn("[password-sync] failed (non-fatal):", e)
  }
}

export type IdentityStatus = {
  userId: string
  username: string
  displayName: string | null
  isAdmin: boolean
  linuxExists: boolean
  uid?: number
  gid?: number
  groups?: string[]
  sambaEnabled: boolean
  sambaExists: boolean
  /** Human-readable summary of the one thing worth flagging, if any — null when
   *  Linux/Samba state matches what HSI expects. Kept server-side so the
   *  reconciliation rule lives in one place, not duplicated into the frontend. */
  issue: string | null
}

function describeIssue(u: {
  linuxExists: boolean; sambaEnabled: boolean; sambaExists: boolean
}): string | null {
  if (!u.linuxExists) return "No Linux account — password sync has never succeeded for this user."
  if (u.sambaEnabled && !u.sambaExists) return "Samba enabled, but no Samba account exists yet — will sync on next login or password change."
  if (!u.sambaEnabled && u.sambaExists) return "Samba disabled, but a Samba account still exists — see docs/manage-without-hsi.md to remove it."
  return null
}

/** Real OS-level identity for every HSI user, alongside what HSI itself expects —
 *  the "Account / HSI identity / Linux identity / Samba identity" view. One batch
 *  call to the root-worker rather than one per user. */
export async function getIdentityStatus(prisma: PrismaClient): Promise<IdentityStatus[]> {
  const users = await prisma.user.findMany({
    select: { id: true, username: true, displayName: true, isAdmin: true, sambaEnabled: true },
    orderBy: { createdAt: "asc" },
  })
  const linuxUsers = users.filter(u => reLinuxUsername.test(u.username))
  let infos: Array<{
    username: string; linuxExists: boolean; uid?: number; gid?: number
    groups?: string[]; sambaExists: boolean
  }> = []
  try {
    const res = await requestSync<{ users: typeof infos }>(
      "root.linux.user.info",
      { usernames: linuxUsers.map(u => u.username) },
    )
    infos = res.users
  } catch {
    // Worker unreachable — fall through with linuxExists:false for everyone below,
    // which correctly reads as "can't confirm" rather than a thrown error.
  }
  const byUsername = new Map(infos.map(i => [i.username, i]))

  return users.map(u => {
    const info = byUsername.get(u.username)
    const linuxExists = info?.linuxExists ?? false
    const sambaExists = info?.sambaExists ?? false
    return {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      isAdmin: u.isAdmin,
      linuxExists,
      uid: info?.uid,
      gid: info?.gid,
      groups: info?.groups,
      sambaEnabled: u.sambaEnabled,
      sambaExists,
      issue: describeIssue({ linuxExists, sambaEnabled: u.sambaEnabled, sambaExists }),
    }
  })
}
