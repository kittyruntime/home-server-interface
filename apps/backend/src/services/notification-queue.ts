import { prisma } from "@app/database"
import { log } from "../utils/log"
import { resolveStored } from "./notification-connectors"
import { deliverResolved, type DeliveryResult } from "./notification-transports"
import type { NotificationEvent } from "./notifications"

// Outbox for external deliveries. dispatchEvent inserts pending rows; a poller
// makes one attempt per due row per tick, reschedules failures with backoff,
// and delays (never drops) rows beyond a connector's rate limit. Rows survive
// restarts; a row caught mid-send by a crash is retried (at-least-once).

export const MAX_ATTEMPTS = 3
export const RETRY_DELAYS_MS = [2_000, 10_000]
export const QUEUE_CAP = 500
export const KEEP_TERMINAL = 200
export const TICK_MS = 2_000
export const BATCH_SIZE = 20

export interface QueueRow { id: string; connectorId: string; attempts: number; event: string }
export interface RowPatch { status?: string; attempts?: number; nextAttemptAt?: Date; sentAt?: Date | null; error?: string }

export interface DeliveryStore {
  resetSending(): Promise<number>
  due(now: Date, limit: number): Promise<QueueRow[]>
  connector(id: string): Promise<{ enabled: boolean; rateLimitPerMinute: number } | null>
  sentSince(connectorId: string, since: Date): Promise<Date[]>
  update(id: string, patch: RowPatch): Promise<void>
  insertPending(rows: Array<{ connectorId: string; event: string; now: Date }>): Promise<void>
  oldestPending(count: number): Promise<string[]>
  countPending(): Promise<number>
  prune(keep: number): Promise<void>
}

export type Deliver = (connectorId: string, event: NotificationEvent) => Promise<DeliveryResult>

export function planAfterAttempt(attemptsBefore: number, result: DeliveryResult, now: Date) {
  const attempts = attemptsBefore + 1
  if (result.ok) return { status: "sent", attempts, nextAttemptAt: now, sentAt: now as Date | null, error: "" }
  const error = result.error ?? "unknown error"
  if (attempts >= MAX_ATTEMPTS) return { status: "failed", attempts, nextAttemptAt: now, sentAt: now as Date | null, error }
  const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!
  return { status: "pending", attempts, nextAttemptAt: new Date(now.getTime() + delay), sentAt: null as Date | null, error }
}

/** Null when a send is allowed at `now`, else the earliest time it is. */
export function rateLimitedUntil(recentSentAts: Date[], limitPerMinute: number, now: Date): Date | null {
  const windowStart = now.getTime() - 60_000
  const inWindow = recentSentAts.map(d => d.getTime()).filter(t => t > windowStart).sort((a, b) => a - b)
  const limit = Math.max(1, limitPerMinute)
  if (inWindow.length < limit) return null
  return new Date(inWindow[inWindow.length - limit]! + 60_000)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Ticks never overlap, so a row still "sending" when a tick starts was left
// behind by an aborted tick (a failed DB write, a crash): send it again.
export async function runDeliveryTick(store: DeliveryStore, deliver: Deliver, now: Date = new Date()): Promise<void> {
  await store.resetSending()
  const rows = await store.due(now, BATCH_SIZE)
  for (const row of rows) {
    const connector = await store.connector(row.connectorId)
    if (!connector || !connector.enabled) {
      await store.update(row.id, { status: "failed", sentAt: now, error: connector ? "connector disabled" : "connector removed" })
      continue
    }
    const until = rateLimitedUntil(await store.sentSince(row.connectorId, new Date(now.getTime() - 60_000)), connector.rateLimitPerMinute, now)
    if (until) {
      await store.update(row.id, { nextAttemptAt: until })
      continue
    }
    let event: NotificationEvent
    try {
      event = JSON.parse(row.event) as NotificationEvent
    } catch {
      await store.update(row.id, { status: "failed", sentAt: now, error: "invalid event" })
      continue
    }
    await store.update(row.id, { status: "sending" })
    let result: DeliveryResult
    try {
      result = await deliver(row.connectorId, event)
    } catch (e) {
      result = { ok: false, error: errorMessage(e) }
    }
    await store.update(row.id, planAfterAttempt(row.attempts, result, now))
  }
}

export async function enqueue(store: DeliveryStore, connectorIds: string[], event: NotificationEvent, now: Date = new Date()): Promise<void> {
  if (connectorIds.length === 0) return
  await store.insertPending(connectorIds.map(connectorId => ({ connectorId, event: JSON.stringify(event), now })))
  const overflow = (await store.countPending()) - QUEUE_CAP
  if (overflow > 0) {
    for (const id of await store.oldestPending(overflow)) await store.update(id, { status: "failed", sentAt: now, error: "queue full" })
    log.warn({ dropped: overflow }, "notifications: delivery queue full, oldest pending deliveries failed")
  }
}

export const prismaDeliveryStore: DeliveryStore = {
  async resetSending() {
    const r = await prisma.notificationDelivery.updateMany({ where: { status: "sending" }, data: { status: "pending" } })
    return r.count
  },
  async due(now, limit) {
    return prisma.notificationDelivery.findMany({
      where: { status: "pending", nextAttemptAt: { lte: now } },
      orderBy: { at: "asc" }, take: limit,
      select: { id: true, connectorId: true, attempts: true, event: true },
    })
  },
  async connector(id) {
    return prisma.notificationConnector.findUnique({ where: { id }, select: { enabled: true, rateLimitPerMinute: true } })
  },
  async sentSince(connectorId, since) {
    const rows = await prisma.notificationDelivery.findMany({
      where: { connectorId, status: "sent", test: false, sentAt: { gt: since } }, select: { sentAt: true },
    })
    return rows.map(r => r.sentAt!)
  },
  async update(id, patch) {
    await prisma.notificationDelivery.update({
      where: { id },
      data: { ...patch, ...(patch.status ? { ok: patch.status === "sent" } : {}) },
    })
  },
  async insertPending(rows) {
    await prisma.notificationDelivery.createMany({
      data: rows.map(r => ({ connectorId: r.connectorId, event: r.event, status: "pending", nextAttemptAt: r.now, at: r.now })),
    })
  },
  async oldestPending(count) {
    const rows = await prisma.notificationDelivery.findMany({ where: { status: "pending" }, orderBy: { at: "asc" }, take: count, select: { id: true } })
    return rows.map(r => r.id)
  },
  countPending: () => prisma.notificationDelivery.count({ where: { status: "pending" } }),
  async prune(keep) {
    const terminal = { status: { in: ["sent", "failed"] } }
    const rows = await prisma.notificationDelivery.findMany({ where: terminal, orderBy: { at: "desc" }, skip: keep - 1, take: 1, select: { at: true } })
    if (rows[0]) await prisma.notificationDelivery.deleteMany({ where: { ...terminal, at: { lt: rows[0].at } } })
  },
}

export const deliverToConnector: Deliver = async (connectorId, event) => {
  const row = await prisma.notificationConnector.findUnique({ where: { id: connectorId } })
  if (!row) return { ok: false, error: "connector removed" }
  // A SecretsError (missing key, unreadable secret) is caught by the tick as a failed attempt.
  return deliverResolved(resolveStored(row), event)
}

export function enqueueDeliveries(connectorIds: string[], event: NotificationEvent): Promise<void> {
  return enqueue(prismaDeliveryStore, connectorIds, event)
}

let started = false

export async function startDeliveryQueue(): Promise<void> {
  if (started) return
  started = true
  const reset = await prismaDeliveryStore.resetSending()
  if (reset > 0) log.info({ count: reset }, "notifications: retrying deliveries interrupted by a restart")
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await runDeliveryTick(prismaDeliveryStore, deliverToConnector)
      await prismaDeliveryStore.prune(KEEP_TERMINAL)
    } catch (e) {
      log.error({ err: e }, "notifications: delivery tick failed")
    } finally {
      running = false
    }
  }, TICK_MS)
  timer.unref()
}
