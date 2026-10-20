import { prisma } from "@app/database"
import { requestSync } from "../nats"
import { log } from "../utils/log"

// Shapes of the root-worker's root.backup.* replies (apps/root-worker/backup_nats.go).
export interface RunRecord {
  runId?: string
  start: string
  end?: string
  status: "running" | "success" | "failed"
  snapshotId?: string
  consistent?: boolean
  added?: number
  files?: number
  error?: string
  warnings?: string[]
  /** Restores only: the folder written, or the restored path. */
  target?: string
}

export interface BackupPlanStatus {
  id: string
  name: string
  type: "sync" | "versions"
  enabled: boolean
  schedule: { every: string; minute: number; hour: number; weekday: number }
  sync?: Record<string, unknown>
  versions?: {
    sources: string[]
    repository: string
    excludes: string[]
    stopApps: string[]
    retention: { keepLast: number; keepDaily: number; keepWeekly: number; keepMonthly: number }
  }
  nextRun: string | null
  last: RunRecord | null
  progress: { percentDone: number } | null
}

export interface BackupRepositoryStatus {
  id: string
  name: string
  type: "local" | "sftp" | "s3" | "rest"
  path?: string
  host?: string
  user?: string
  port?: number
  endpoint?: string
  bucket?: string
  url?: string
  check: { every: string; hour: number; weekday: number; day: number; subset: string }
  hasPassword: boolean
  nextCheck: string | null
  lastCheck: RunRecord | null
}

export interface BackupStatus {
  configExists: boolean
  engine: { installed: boolean; version: string }
  plans: BackupPlanStatus[]
  repositories: BackupRepositoryStatus[]
}

export interface BackupFinding { target: string; severity: "warning" | "critical"; message: string }

export function backupFindings(s: BackupStatus): BackupFinding[] {
  const out: BackupFinding[] = []
  for (const p of s.plans) {
    if (p.last?.status !== "failed") continue
    const error = p.last.error ?? "unknown error"
    out.push({
      target: `plan:${p.id}`,
      // An app that stayed down is an outage, not just a missed backup.
      severity: error.includes("did not start again") ? "critical" : "warning",
      message: `Backup "${p.name}" failed: ${error}`,
    })
  }
  for (const r of s.repositories) {
    if (r.lastCheck?.status !== "failed") continue
    out.push({ target: `repository:${r.id}`, severity: "critical", message: `Integrity check of "${r.name}" failed: ${r.lastCheck.error ?? "unknown error"}` })
  }
  if (!s.engine.installed && s.plans.some(p => p.type === "versions")) {
    out.push({ target: "engine", severity: "warning", message: "The backup engine (restic) is not installed: run the installer again" })
  }
  return out
}

/** Every target backupFindings can raise, so a cleared alert is detected. */
export function backupTargets(s: BackupStatus): string[] {
  return ["engine", ...s.plans.map(p => `plan:${p.id}`), ...s.repositories.map(r => `repository:${r.id}`)]
}

/** Dotted like every other alert source: the Alerts filter and notification rules match on "backup.". */
export const BACKUP_ALERT_SOURCE = "backup.status"

const MIGRATION_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]
const MIGRATION_RETRY_MS = 30_000
const MIGRATION_GIVE_UP_MS = 10 * 60_000

interface MigrationDeps {
  request: (subject: string, body: Record<string, unknown>, timeoutMs: number) => Promise<any>
  rows: () => Promise<unknown[]>
  sleep: (ms: number) => Promise<void>
}

const defaultMigrationDeps: MigrationDeps = {
  request: requestSync,
  rows: () => prisma.backupPlan.findMany(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/**
 * Turns the rsync plans of the former table into sync plans, once, at start. The
 * worker may not be ready yet: the status request is retried with a backoff for
 * about ten minutes, because the old plans have no scheduler until they migrate.
 */
export async function migrateRsyncPlans(deps: MigrationDeps = defaultMigrationDeps): Promise<void> {
  let waited = 0
  for (let attempt = 0; ; attempt++) {
    try {
      const status = await deps.request("root.backup.status", {}, 15_000) as BackupStatus
      if (status.configExists) return
      const rows = await deps.rows()
      if (rows.length === 0) return
      const res = await deps.request("root.backup.migrate", { plans: rows }, 60_000) as { migrated: number; skipped: Array<{ name: string; error: string }> }
      log.info({ migrated: res.migrated }, "backup: migrated the former rsync plans")
      for (const s of res.skipped) log.warn({ plan: s.name, error: s.error }, "backup: a former rsync plan was not migrated")
      return
    } catch (e) {
      const delay = MIGRATION_DELAYS_MS[attempt] ?? MIGRATION_RETRY_MS
      if (waited + delay > MIGRATION_GIVE_UP_MS) {
        log.error({ err: e }, "backup: migration of the former rsync plans failed, giving up")
        return
      }
      await deps.sleep(delay)
      waited += delay
    }
  }
}
