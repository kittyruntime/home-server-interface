import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"
import { prisma, PrismaClient } from "@app/database"
import { renderWebhookRequest, sampleEvent, WEBHOOK_PRESETS, IN_APP_CONNECTOR_ID } from "../../services/notifications"
import {
  DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT, SECRET_MASK, SMTP_PRESETS, maskUrl, mergeConnectorInput, resolveStored,
  toPublicConnector, toStoredFields, type ConnectorInput, type ResolvedConnector,
} from "../../services/notification-connectors"
import { deliverResolved, renderEmail } from "../../services/notification-transports"

const severityEnum = z.enum(["info", "warning", "critical"])

const webhookPart = z.object({
  type: z.literal("webhook"),
  method: z.enum(["POST", "PUT"]).default("POST"),
  url: z.string().max(2048),
  headers: z.string().default("{}"),
  bodyTemplate: z.string(),
})

const smtpPart = z.object({
  type: z.literal("smtp"),
  smtp: z.object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    security: z.enum(["starttls", "tls", "none"]),
    username: z.string().max(255).default(""),
    password: z.string().max(1024).default(""),
    from: z.string().email(),
    to: z.array(z.string().email()).min(1).max(20),
    subjectTemplate: z.string().max(500),
    bodyTemplate: z.string().max(10_000),
  }),
})

const connectorPart = z.discriminatedUnion("type", [webhookPart, smtpPart])
const connectorMeta = z.object({
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  rateLimitPerMinute: z.number().int().min(1).max(600).default(10),
})
const connectorForm = z.intersection(connectorPart, connectorMeta)
const optionalId = z.object({ id: z.string().uuid().optional() })

// Maps secret and validation failures to a 400 with the real message.
function badRequest(e: unknown): never {
  if (e instanceof TRPCError) throw e
  throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) })
}

// Plaintext connector for an input, merged with the stored secrets when the
// input refers to an existing connector (masked fields keep their value).
async function resolveInput(db: PrismaClient, input: ConnectorInput, id?: string): Promise<ResolvedConnector> {
  let stored: ResolvedConnector | null = null
  if (id) {
    const row = await db.notificationConnector.findUnique({ where: { id } })
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Connector not found" })
    try {
      stored = resolveStored(row)
    } catch {
      stored = null // unreadable: every secret must be re-entered
    }
  }
  try {
    return mergeConnectorInput(input, stored)
  } catch (e) {
    badRequest(e)
  }
}

function partOf(input: z.infer<typeof connectorPart>): ConnectorInput {
  return input.type === "smtp"
    ? { type: "smtp", smtp: input.smtp }
    : { type: "webhook", method: input.method, url: input.url, headers: input.headers, bodyTemplate: input.bodyTemplate }
}

function storedData(resolved: ResolvedConnector) {
  try {
    return toStoredFields(resolved)
  } catch (e) {
    badRequest(e)
  }
}

const ruleInput = z.object({
  name: z.string().min(1).max(64),
  sourcePrefix: z.string().max(64).default(""),
  minSeverity: severityEnum.default("warning"),
  connectorIds: z.array(z.string()).min(1),
  enabled: z.boolean().default(true),
})

// Every target must be the built-in in-app connector or an existing connector.
async function resolveConnectorIds(db: PrismaClient, connectorIds: string[]): Promise<string[]> {
  const unique = [...new Set(connectorIds)]
  const connectors = await db.notificationConnector.findMany({ select: { id: true } })
  const known = new Set(connectors.map(c => c.id))
  for (const id of unique) {
    if (id !== IN_APP_CONNECTOR_ID && !known.has(id)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown connector id: ${id}` })
    }
  }
  return unique
}

export const notificationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const [items, unread] = await Promise.all([
      ctx.prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
      ctx.prisma.notification.count({ where: { readAt: null } }),
    ])
    return { items, unread }
  }),

  markAllRead: protectedProcedure.mutation(({ ctx }) =>
    ctx.prisma.notification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } }),
  ),

  connectors: router({
    list: adminProcedure.query(async ({ ctx }) => {
      const rows = await ctx.prisma.notificationConnector.findMany({ orderBy: { createdAt: "asc" } })
      return rows.map(r => toPublicConnector(r))
    }),
    presets: adminProcedure.query(() => ({
      webhook: WEBHOOK_PRESETS,
      smtp: SMTP_PRESETS,
      emailDefaults: { subjectTemplate: DEFAULT_EMAIL_SUBJECT, bodyTemplate: DEFAULT_EMAIL_BODY },
    })),
    create: adminProcedure.input(connectorForm).mutation(async ({ ctx, input }) => {
      const resolved = await resolveInput(ctx.prisma, partOf(input))
      const row = await ctx.prisma.notificationConnector.create({
        data: { name: input.name, enabled: input.enabled, rateLimitPerMinute: input.rateLimitPerMinute, ...storedData(resolved) },
      })
      return toPublicConnector(row)
    }),
    update: adminProcedure.input(z.intersection(connectorForm, z.object({ id: z.string().uuid() }))).mutation(async ({ ctx, input }) => {
      const resolved = await resolveInput(ctx.prisma, partOf(input), input.id)
      const row = await ctx.prisma.notificationConnector.update({
        where: { id: input.id },
        data: { name: input.name, enabled: input.enabled, rateLimitPerMinute: input.rateLimitPerMinute, ...storedData(resolved) },
      })
      return toPublicConnector(row)
    }),
    // Toggling must not round-trip secrets through the browser.
    setEnabled: adminProcedure.input(z.object({ id: z.string().uuid(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      await ctx.prisma.notificationConnector.update({ where: { id: input.id }, data: { enabled: input.enabled } })
      return { ok: true }
    }),
    delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) =>
      // Orphan rule targets are impossible: strip the id from every rule,
      // atomically with the delete itself.
      ctx.prisma.$transaction(async (tx) => {
        const rules = await tx.notificationRule.findMany()
        for (const rule of rules) {
          const ids: string[] = JSON.parse(rule.connectorIds)
          if (ids.includes(input.id)) {
            await tx.notificationRule.update({
              where: { id: rule.id },
              data: { connectorIds: JSON.stringify(ids.filter(x => x !== input.id)) },
            })
          }
        }
        await tx.notificationConnector.delete({ where: { id: input.id } })
        return { ok: true }
      }),
    ),
  }),

  rules: router({
    list: adminProcedure.query(async ({ ctx }) => ctx.prisma.notificationRule.findMany({ orderBy: { name: "asc" } })),
    create: adminProcedure.input(ruleInput).mutation(async ({ ctx, input }) => {
      const connectorIds = await resolveConnectorIds(ctx.prisma, input.connectorIds)
      return ctx.prisma.notificationRule.create({
        data: { ...input, connectorIds: JSON.stringify(connectorIds) },
      })
    }),
    update: adminProcedure.input(ruleInput.extend({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      const { id, connectorIds, ...data } = input
      const resolved = await resolveConnectorIds(ctx.prisma, connectorIds)
      return ctx.prisma.notificationRule.update({
        where: { id },
        data: { ...data, connectorIds: JSON.stringify(resolved) },
      })
    }),
    delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ ctx, input }) =>
      ctx.prisma.notificationRule.delete({ where: { id: input.id } })),
  }),

  renderPreview: adminProcedure.input(z.intersection(connectorPart, optionalId)).query(async ({ ctx, input }) => {
    const resolved = await resolveInput(ctx.prisma, partOf(input), input.id)
    const event = sampleEvent()
    if (resolved.type === "smtp") return { type: "smtp" as const, email: renderEmail(resolved.smtp, event) }
    const request = renderWebhookRequest(
      { method: resolved.method, url: resolved.url, headers: JSON.stringify(resolved.headers), bodyTemplate: resolved.bodyTemplate },
      event,
    )
    // The preview is shown in the browser: mask secrets the same way as `list`.
    const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) =>
      [k, k.toLowerCase() === "content-type" ? v : SECRET_MASK]))
    return { type: "webhook" as const, request: { ...request, url: maskUrl(request.url), headers } }
  }),

  testConnector: adminProcedure.input(z.intersection(connectorPart, optionalId)).mutation(async ({ ctx, input }) => {
    const resolved = await resolveInput(ctx.prisma, partOf(input), input.id)
    const event = sampleEvent()
    const result = await deliverResolved(resolved, event) // one attempt, no queue, no rate limit
    await prisma.notificationDelivery.create({
      data: {
        connectorId: input.id ?? "test", status: result.ok ? "sent" : "failed", ok: result.ok, attempts: 1,
        error: result.error ?? "", test: true, sentAt: new Date(), event: JSON.stringify(event),
      },
    })
    return result
  }),

  deliveries: router({
    list: adminProcedure.query(async ({ ctx }) => {
      const [rows, connectors] = await Promise.all([
        ctx.prisma.notificationDelivery.findMany({ orderBy: { at: "desc" }, take: 50 }),
        ctx.prisma.notificationConnector.findMany({ select: { id: true, name: true } }),
      ])
      const names = new Map(connectors.map(c => [c.id, c.name]))
      return rows.map(r => ({
        id: r.id, connectorId: r.connectorId, connectorName: names.get(r.connectorId) ?? r.connectorId,
        status: r.status as "pending" | "sending" | "sent" | "failed", attempts: r.attempts,
        error: r.error ?? "", test: r.test, at: r.at, sentAt: r.sentAt, nextAttemptAt: r.nextAttemptAt,
      }))
    }),
  }),
})
