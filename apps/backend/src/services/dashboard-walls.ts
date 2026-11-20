import crypto from "node:crypto"
import { prisma } from "@app/database"
import { loadCurrentUserAuthorization } from "../utils/request-auth"
import { parseWidgets, type BoardWidget } from "./dashboard-boards"

// Wall displays: a screen shows a copy of a board without signing in. Its
// token opens only the queries the board's widgets read, as the owner, with
// the owner's rights as they are now; it can never change anything.

export const WALL_PREFIX = "hsi_wall_"
export const MAX_WALLS = 10

// What each widget reads. A type not listed reads nothing on its own.
const WIDGET_READS: Record<string, string[]> = {
  cpu: ["system.metrics"], memory: ["system.metrics"], network: ["system.metrics"],
  history: ["system.metricsHistory"],
  sensors: ["dashboard.sensors"],
  ups: ["dashboard.ups"],
  consumers: ["system.processes"],
  digest: ["dashboard.digest"],
  alerts: ["alert.list"],
  volumes: ["storage.volumes.overview"],
  disks: ["storage.blockDevices", "storage.smartInfo"],
  forecast: ["dashboard.forecast", "storage.volumes.overview"],
  backups: ["backup.status"],
  trash: ["trash.list"],
  apps: ["container.app.list"],
  updates: ["update.status", "tls.status", "container.app.list"],
  activity: ["tasks.list"],
  shares: ["sharing.sessions", "shareLink.listMine"],
  journal: ["audit.list"],
  places: ["place.list"],
  links: ["dashboard.linkStatus"],
  custom: ["widgetSource.data"],
}
// The display itself, and the status line above the widgets.
const ALWAYS = ["dashboard.wall", "alert.list", "update.status"]

export type WallAuth = { id: string; allowed: Set<string>; sourceIds: Set<string> }

/** The queries a board's widgets read, and the custom widgets' sources. */
export function wallAccess(widgets: BoardWidget[]): { allowed: Set<string>; sourceIds: Set<string> } {
  const allowed = new Set(ALWAYS)
  const sourceIds = new Set<string>()
  for (const w of widgets) {
    for (const p of WIDGET_READS[w.type] ?? []) allowed.add(p)
    const custom = w.settings?.custom as { sources?: unknown } | undefined
    if (w.type === "custom" && Array.isArray(custom?.sources)) {
      for (const s of custom.sources) if (typeof s === "string") sourceIds.add(s)
    }
  }
  return { allowed, sourceIds }
}

/** A call a display may make: a query its widgets read. */
export const wallMayCall = (wall: Pick<WallAuth, "allowed">, path: string, type: string) => type === "query" && wall.allowed.has(path)

export const hashWallToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex")

export function newWallToken(): { token: string; hash: string; prefix: string } {
  const token = WALL_PREFIX + crypto.randomBytes(24).toString("base64url")
  return { token, hash: hashWallToken(token), prefix: token.slice(0, WALL_PREFIX.length + 4) }
}

const SEEN_EVERY_MS = 60_000

/** The owner and the display behind `Authorization: Bearer hsi_wall_…`, or null. */
export async function authenticateWall(authorization: string | undefined) {
  if (!authorization?.startsWith("Bearer " + WALL_PREFIX)) return null
  const wall = await prisma.dashboardWall.findUnique({ where: { tokenHash: hashWallToken(authorization.slice(7).trim()) } })
  if (!wall) return null
  const owner = await loadCurrentUserAuthorization(wall.ownerId)
  if (!owner) return null
  if (!wall.lastSeenAt || Date.now() - wall.lastSeenAt.getTime() > SEEN_EVERY_MS) {
    void prisma.dashboardWall.update({ where: { id: wall.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
  }
  const widgets = parseWidgets(wall.widgets)
  return {
    user: {
      userId: wall.ownerId,
      jti: "wall:" + wall.id,
      isAdmin: owner.isAdmin,
      isUserManager: owner.isAdmin || owner.isUserManager,
      // A display only reads; a pending password change does not stop it.
      mustChangePassword: false,
      capabilities: owner.capabilities.map(c => c.capability),
    },
    wall: { id: wall.id, ...wallAccess(widgets) } satisfies WallAuth,
  }
}
