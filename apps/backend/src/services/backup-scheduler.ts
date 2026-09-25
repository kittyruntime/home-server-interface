import { prisma } from "@app/database"
import { publishJob } from "../nats"
import { dispatchEvent } from "./notifications"

let timer: NodeJS.Timeout | undefined

export function nextBackupRun(schedule: string, hour: number, minute: number, weekday: number, from = new Date()): Date | null {
  if (schedule === "manual") return null
  const next = new Date(from)
  next.setSeconds(0, 0)
  if (schedule === "hourly") {
    next.setMinutes(minute)
    if (next <= from) next.setHours(next.getHours() + 1)
  } else {
    next.setHours(hour, minute, 0, 0)
    if (schedule === "daily" && next <= from) next.setDate(next.getDate() + 1)
    if (schedule === "weekly") {
      let days = (weekday - next.getDay() + 7) % 7
      if (days === 0 && next <= from) days = 7
      next.setDate(next.getDate() + days)
    }
  }
  return next
}

export async function runBackupPlan(id: string, userId?: string) {
  const plan = await prisma.backupPlan.findUniqueOrThrow({ where: { id } })
  if (plan.lastStatus === "pending" || plan.lastStatus === "running") throw new Error("Backup is already running")
  const jobId = await publishJob("backup.rsync", {
    planId: plan.id, direction: plan.direction, source: plan.source, destination: plan.destination,
    remoteHost: plan.remoteHost, remoteUser: plan.remoteUser, remotePort: plan.remotePort,
    sshKeyPath: plan.sshKeyPath, deleteExtra: plan.deleteExtra, compress: plan.compress,
    bandwidthLimit: plan.bandwidthLimit, excludes: JSON.parse(plan.excludes),
  }, userId)
  await prisma.backupPlan.update({ where: { id }, data: { lastJobId: jobId, lastStatus: "pending", lastRunAt: new Date(), lastError: null } })
  return { jobId }
}

async function tick() {
  const now = new Date()
  const finished = await prisma.backupPlan.findMany({ where: { lastJobId: { not: null }, lastStatus: { in: ["pending", "running"] } } })
  for (const plan of finished) {
    const job = await prisma.job.findUnique({ where: { id: plan.lastJobId! } })
    if (job && ["completed", "failed"].includes(job.status)) {
      await prisma.backupPlan.update({ where: { id: plan.id }, data: { lastStatus: job.status, lastError: job.error, nextRunAt: nextBackupRun(plan.schedule, plan.scheduleHour, plan.scheduleMinute, plan.scheduleWeekday, now) } })
      if (job.status === "failed") {
        // Routed like alerts (source prefix "backup.", severity), so a rule
        // can send failed backups to email/webhook targets.
        void dispatchEvent({
          type: "job.failed", severity: "warning", source: "backup.plan", target: plan.name,
          message: `Backup "${plan.name}" failed: ${job.error ?? "unknown error"}`, time: now.toISOString(),
        })
      }
    }
  }
  const due = await prisma.backupPlan.findMany({ where: { enabled: true, schedule: { not: "manual" }, nextRunAt: { lte: now }, OR: [{ lastStatus: null }, { lastStatus: { notIn: ["pending", "running"] } }] } })
  for (const plan of due) {
    try { await runBackupPlan(plan.id) } catch { /* retried on the next scheduler tick */ }
  }
}

export function startBackupScheduler() {
  if (timer) return
  void tick()
  timer = setInterval(() => void tick(), 30_000)
  timer.unref()
}
