import { prisma, type PrismaClient } from "@app/database"
import { log } from "../utils/log"
import { loadHsiConfig } from "./hsi-config"

const DAY_MS = 24 * 60 * 60 * 1000

/** Deletes audit entries older than retentionDays (0 keeps everything). Returns how many went. */
export async function purgeAuditLog(db: Pick<PrismaClient, "auditLog">, retentionDays: number, now = new Date()): Promise<number> {
  if (retentionDays <= 0) return 0
  const { count } = await db.auditLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - retentionDays * DAY_MS) } } })
  return count
}

// Once at start, then daily: audit.retention_days in hsi.toml (a year by default).
export function startAuditRetention(): void {
  const run = async () => {
    try {
      const { audit } = await loadHsiConfig()
      const count = await purgeAuditLog(prisma, audit.retentionDays)
      if (count > 0) log.info({ count, retentionDays: audit.retentionDays }, "audit log: old entries removed")
    } catch (e) {
      log.error({ err: e }, "audit log retention failed")
    }
  }
  void run()
  setInterval(run, DAY_MS).unref()
}
