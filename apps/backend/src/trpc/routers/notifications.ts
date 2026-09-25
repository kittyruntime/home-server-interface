import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"
import { prisma, PrismaClient } from "@app/database"
import {
  attemptWebhook, renderWebhookRequest, sampleEvent, WEBHOOK_PRESETS,
} from "../../services/notifications"

const severityEnum = z.enum(["info", "warning", "critical"])

const connectorInput = z.object({
  name: z.string().min(1).max(64),
  type: z.literal("webhook"),
  method: z.enum(["POST", "PUT"]).default("POST"),
  url: z.string().url(),
  headers: z.string().default("{}"),
  bodyTemplate: z.string(),
  enabled: z.boolean().default(true),
})

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
    if (id !== "inapp" && !known.has(id)) {
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
    list: adminProcedure.query(async ({ ctx }) => ctx.prisma.notificationConnector.findMany({ orderBy: { createdAt: "asc" } })),
    presets: adminProcedure.query(() => WEBHOOK_PRESETS),
    create: adminProcedure.input(connectorInput).mutation(({ ctx, input }) =>
      ctx.prisma.notificationConnector.create({ data: input })),
    update: adminProcedure.input(connectorInput.extend({ id: z.string().uuid() })).mutation(({ ctx, input }) => {
      const { id, ...data } = input
      return ctx.prisma.notificationConnector.update({ where: { id }, data })
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

  renderPreview: adminProcedure.input(z.object({
    method: z.enum(["POST", "PUT"]),
    url: z.string(),
    headers: z.string(),
    bodyTemplate: z.string(),
  })).query(({ input }) => renderWebhookRequest(input, sampleEvent())),

  testConnector: adminProcedure.input(z.object({
    id: z.string().optional(), // absent when testing an unsaved connector
    method: z.enum(["POST", "PUT"]),
    url: z.string().url(),
    headers: z.string(),
    bodyTemplate: z.string(),
  })).mutation(async ({ input }) => {
    const event = sampleEvent()
    const req = renderWebhookRequest(input, event)
    const result = await attemptWebhook(req, { delays: [0] }) // single attempt, no retry storm
    await prisma.notificationDelivery.create({
      data: { connectorId: input.id ?? "test", ok: result.ok, error: result.error ?? "", test: true },
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
      return rows.map(r => ({ ...r, connectorName: names.get(r.connectorId) ?? r.connectorId }))
    }),
  }),
})
