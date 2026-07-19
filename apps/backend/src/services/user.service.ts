import bcrypt from "bcryptjs"
import { TRPCError } from "@trpc/server"
import type { PrismaClient } from "@app/database"
import { requestSync } from "../nats"

/** Seeded default password for the initial `admin` account. Surfaced so the
 *  dashboard can warn while it's still in use (see user.securityStatus). */
export const DEFAULT_PASSWORD = "admin"

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
  createdAt: true,
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

  if (reLinuxUsername.test(input.username)) {
    try {
      await requestSync("root.linux.user.create", { username: input.username })
      await syncSystemPassword(prisma, user.id, input.password)
    } catch (e) {
      console.warn("[user.create] Linux user creation failed (non-fatal):", e)
    }
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
    data: { password: newHashed },
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
      select: { username: true },
    })
    if (!user?.username) return
    const res = await requestSync<{ linuxOk?: boolean; smbOk?: boolean }>(
      "root.sharing.setPassword",
      { linuxUsername: user.username, password: plainPassword },
    )
    // The worker replies ok even when a sub-step fails (best-effort). Surface a
    // partial failure so "can't connect to SMB" is diagnosable from the logs
    // instead of silent — the most common cause of Samba auth being refused.
    if (res?.smbOk === false) {
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
