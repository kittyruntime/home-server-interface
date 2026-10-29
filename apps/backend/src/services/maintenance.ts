import { readWorkerUpdateStatus, NO_RESTART_FAILURE_AFTER_MS, type UpdateResult } from "./update-watch"

// An update, an HSI restart or a host reboot in progress (#132). While it
// lasts, every dashboard shows a blocking overlay and mutations are refused,
// so nobody changes the server while it goes down.
//
// The state lives in the backend process that accepted the request: the
// restart it leads to starts a new process, which has none. So "maintenance
// over" is simply "a new backend answers". The expiries cover the cases where
// the restart never comes (a reboot the host ignored, an installer that died
// before restarting anything); an update refused or failed before any restart
// ends as soon as the worker reports its result.

export type MaintenanceKind = "update" | "restart" | "reboot"
export interface Maintenance { kind: MaintenanceKind; target: string | null; since: string }

const EXPIRES_AFTER_MS: Record<MaintenanceKind, number> = {
  update:  NO_RESTART_FAILURE_AFTER_MS,
  restart: 5 * 60_000,
  reboot:  15 * 60_000,
}

let current: Maintenance | null = null

export function beginMaintenance(kind: MaintenanceKind, target: string | null = null, now = new Date()): void {
  current = { kind, target, since: now.toISOString() }
  cached = null
}

/** For tests. */
export function resetMaintenance(): void {
  current = null
  cached = null
}

/** Whether m still holds at now, given the worker's last update result. */
export function maintenanceHolds(m: Maintenance, now: Date, lastUpdate: UpdateResult | null): boolean {
  const since = Date.parse(m.since)
  if (now.getTime() - since >= EXPIRES_AFTER_MS[m.kind]) return false
  // The worker finished this update without restarting the backend
  // (refused, or failed and rolled back while this process kept running).
  if (m.kind === "update" && lastUpdate && lastUpdate.to === m.target && Date.parse(lastUpdate.at) >= since) return false
  return true
}

// Mutations ask on every call: keep the worker round trip off the hot path.
const CACHE_MS = 2_000
let cached: { at: number; value: Maintenance | null } | null = null

export async function currentMaintenance(
  now = new Date(), readStatus: typeof readWorkerUpdateStatus = readWorkerUpdateStatus,
): Promise<Maintenance | null> {
  if (!current) return null
  if (cached && now.getTime() - cached.at < CACHE_MS) return cached.value
  const last = current.kind === "update" ? (await readStatus())?.last ?? null : null
  if (current && !maintenanceHolds(current, now, last)) current = null
  cached = { at: now.getTime(), value: current }
  return current
}
