import type { PrismaClient } from "@app/database"
import { requestSync } from "../nats"

// Never expose privileged/system accounts over Samba: writing to shares as root
// is unsafe and Samba blocks it anyway (a root SMB login falls back to guest →
// read-only). A user mapped to such an account simply isn't a share user — use a
// normal account for SMB.
const NON_SHAREABLE_LINUX = new Set(["root"])
function isShareableLinux(linux: string | null | undefined): linux is string {
  return !!linux && !NON_SHAREABLE_LINUX.has(linux)
}

/** Linux usernames of all admins (excluding root/system accounts) — admins have
 *  full access, so they're added to every share/place's write set. */
async function adminLinuxUsers(prisma: PrismaClient): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { linuxUsername: { not: null }, userRoles: { some: { role: { isAdmin: true } } } },
    select: { linuxUsername: true },
  })
  return admins.map(a => a.linuxUsername).filter(isShareableLinux)
}

export interface ResolvedShareUsers {
  validUsers: string[]
  writeUsers: string[]
  /** App usernames that have access to the Place but no linuxUsername — they
   *  cannot get a Samba account and are excluded from the effective share. */
  excludedUsernames: string[]
}

/** Aggregates UserPlacePermission + RolePlacePermission for a Place — same
 *  read/write semantics as the rest of the app — into Samba user lists. */
export async function resolveShareUsers(
  prisma: PrismaClient,
  placeId: string,
): Promise<ResolvedShareUsers> {
  const [userPerms, rolePerms] = await Promise.all([
    prisma.userPlacePermission.findMany({
      where: { placeId, canRead: true },
      select: {
        canWrite: true,
        user: { select: { username: true, linuxUsername: true } },
      },
    }),
    prisma.rolePlacePermission.findMany({
      where: { placeId, canRead: true },
      select: {
        canWrite: true,
        role: {
          select: {
            userRoles: {
              select: { user: { select: { username: true, linuxUsername: true } } },
            },
          },
        },
      },
    }),
  ])

  const byUsername = new Map<string, { linux: string | null; write: boolean }>()
  const add = (u: { username: string; linuxUsername: string | null }, write: boolean) => {
    const cur = byUsername.get(u.username)
    if (cur) cur.write = cur.write || write
    else byUsername.set(u.username, { linux: u.linuxUsername, write })
  }
  for (const p of userPerms) add(p.user, p.canWrite)
  for (const p of rolePerms) for (const ur of p.role.userRoles) add(ur.user, p.canWrite)

  const validUsers: string[] = []
  const writeUsers: string[] = []
  const excludedUsernames: string[] = []
  for (const [username, info] of byUsername) {
    // No linux account, or a blocked system account (root) → can't be a share user.
    if (!isShareableLinux(info.linux)) {
      excludedUsernames.push(username)
      continue
    }
    validUsers.push(info.linux)
    if (info.write) writeUsers.push(info.linux)
  }
  validUsers.sort()
  writeUsers.sort()
  excludedUsernames.sort()
  return { validUsers, writeUsers, excludedUsernames }
}

function sanitizeSmbName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 32)
  return cleaned || "share"
}

export function effectiveSmbName(
  share: { smbName: string | null },
  placeName: string,
): string {
  return share.smbName ?? sanitizeSmbName(placeName)
}

/** Pushes the complete desired SMB state to the root-worker. Samba always
 *  reflects the current DB/permission state — no incremental diffing. */
export async function syncShares(prisma: PrismaClient): Promise<void> {
  const shares = await prisma.share.findMany({
    where: { enabled: true },
    include: { place: { select: { name: true, path: true } } },
  })

  // Admins always have full access in the app — mirror that into Samba so an
  // admin can read/write every share without needing an explicit per-place grant.
  const adminLinux = await adminLinuxUsers(prisma)

  const uniqSorted = (xs: string[]) => [...new Set(xs)].sort()

  const defs = []
  for (const s of shares) {
    const users = await resolveShareUsers(prisma, s.placeId)
    defs.push({
      name: effectiveSmbName(s, s.place.name),
      path: s.place.path,
      readOnly: s.readOnly,
      guestOk: s.guestOk,
      validUsers: uniqSorted([...users.validUsers, ...adminLinux]),
      writeUsers: s.readOnly ? [] : uniqSorted([...users.writeUsers, ...adminLinux]),
    })
  }
  await requestSync("root.sharing.sync", { shares: defs })
}

/** Ensures the *filesystem* access layer for EVERY place that has write-users
 *  (not only SMB-shared ones): the `hsi-share` group's members + each place dir
 *  made group-writable/setgid. This is what lets the web file-manager write (it
 *  writes as the connecting Linux user, same as SMB) even without a share. Runs
 *  independently of Samba. */
export async function syncPlaceAccess(prisma: PrismaClient): Promise<void> {
  const places = await prisma.place.findMany({ select: { id: true, path: true } })
  const adminLinux = await adminLinuxUsers(prisma)
  const defs: { path: string; writeUsers: string[] }[] = []
  for (const p of places) {
    const users = await resolveShareUsers(prisma, p.id)
    const writeUsers = [...new Set([...users.writeUsers, ...adminLinux])]
    if (writeUsers.length) defs.push({ path: p.path, writeUsers })
  }
  await requestSync("root.sharing.placeAccess", { places: defs })
}

/** For hooks riding on unrelated mutations (permission edits, role
 *  assignments…): sharing must never break those flows. Covers both the Samba
 *  config and the filesystem access layer. */
export async function syncSharesBestEffort(prisma: PrismaClient): Promise<void> {
  const results = await Promise.allSettled([syncShares(prisma), syncPlaceAccess(prisma)])
  for (const r of results) {
    if (r.status === "rejected") console.warn("[sharing] sync failed (non-fatal):", r.reason)
  }
}
