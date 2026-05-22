import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, adminProcedure, protectedProcedure, withPermission } from "../index"
import { publishJob, requestSync } from "../../nats"
import {
  listApps, getApp, createApp, updateApp, deleteApp, setAppStatus,
  listNetworks, createNetwork, deleteNetwork,
  listVolumes, createVolume, deleteVolume,
} from "../../services/container.service"

// ── Zod schemas ───────────────────────────────────────────────────────────────

const zPortMapping = z.object({
  hostPort:      z.number().int().min(1).max(65535),
  containerPort: z.number().int().min(1).max(65535),
  protocol:      z.enum(["tcp", "udp"]).default("tcp"),
})

const zEnvVar = z.object({
  key:   z.string().min(1),
  value: z.string(),
})

const zVolumeMount = z.object({
  type:   z.enum(["bind", "named", "place"]),
  source: z.string().min(1),
  target: z.string().startsWith("/"),
})

const zLabelEntry = z.object({
  key:   z.string().min(1),
  value: z.string(),
})

const zAppInput = z.object({
  name:          z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  image:         z.string().min(1),
  ports:         z.array(zPortMapping).default([]),
  envs:          z.array(zEnvVar).default([]),
  volumes:       z.array(zVolumeMount).default([]),
  networkNames:  z.array(z.string()).default([]),
  labels:        z.array(zLabelEntry).default([]),
  capAdd:        z.array(z.string()).default([]),
  capDrop:       z.array(z.string()).default([]),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("no"),
  hostname:      z.string().max(63).nullable().optional(),
  user:          z.string().nullable().optional(),
  command:       z.string().nullable().optional(),
  cpuLimit:      z.number().min(0).max(64).nullable().optional(),
  memoryLimit:   z.string().regex(/^\d+[kmgKMG]?$/).nullable().optional(),
  pinnedUrl:     z.string().url().nullable().optional(),
})

// ── Error mapper ──────────────────────────────────────────────────────────────

function mapWorkerError(e: any): TRPCError {
  if (e instanceof TRPCError) return e
  switch (e?.code) {
    case "EACCES": return new TRPCError({ code: "FORBIDDEN",             message: "Permission denied" })
    case "ENOENT": return new TRPCError({ code: "NOT_FOUND",             message: "Not found" })
    case "EEXIST": return new TRPCError({ code: "CONFLICT",              message: "Already exists" })
    default:       return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e?.message ?? "Unknown error" })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Replace place-type volume mounts with their real host path. */
async function resolvePlaceMounts(
  prisma: any,
  volumes: Array<{ type: string; source: string; target: string }>,
) {
  return Promise.all(volumes.map(async (v) => {
    if (v.type !== "place") return v
    const place = await prisma.place.findUnique({ where: { id: v.source } })
    if (!place) throw new TRPCError({ code: "NOT_FOUND", message: `Place ${v.source} not found` })
    return { ...v, type: "bind" as const, source: place.path }
  }))
}

// ── App sub-router ────────────────────────────────────────────────────────────

const canView   = withPermission("container.view")
const canCreate = withPermission("container.create")
const canDelete = withPermission("container.delete")
const canManage = withPermission("container.manage")

const appRouter = router({
  list: protectedProcedure.use(canView).query(({ ctx }) => listApps(ctx.prisma)),

  listPinned: protectedProcedure.query(async ({ ctx }) => {
    const apps = await listApps(ctx.prisma)
    return apps
      .filter(a => a.pinnedUrl)
      .map(a => ({ id: a.id, name: a.name, status: a.status, pinnedUrl: a.pinnedUrl! }))
  }),

  pin: adminProcedure
    .input(z.object({ id: z.string(), pinnedUrl: z.string().url().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.containerApp.update({
        where: { id: input.id },
        data:  { pinnedUrl: input.pinnedUrl ?? null },
      })
      return { ok: true }
    }),

  get: protectedProcedure.use(canView)
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => getApp(ctx.prisma, input.id)),

  create: protectedProcedure.use(canCreate)
    .input(zAppInput)
    .mutation(async ({ ctx, input }) => {
      const app = await createApp(ctx.prisma, input)
      const resolvedVolumes = await resolvePlaceMounts(ctx.prisma, input.volumes)
      const jobId = await publishJob("container.create", {
        containerName: app.name,
        image:         app.image,
        ports:         app.ports,
        envs:          app.envs,
        volumes:       resolvedVolumes,
        networkNames:  app.networkNames,
        labels:        app.labels,
        capAdd:        app.capAdd,
        capDrop:       app.capDrop,
        restartPolicy: app.restartPolicy,
        hostname:      app.hostname,
        user:          app.user,
        command:       app.command,
        cpuLimit:      app.cpuLimit,
        memoryLimit:   app.memoryLimit,
      }, ctx.user.userId)
      return { app, jobId }
    }),

  update: adminProcedure
    .input(z.object({ id: z.string(), data: zAppInput }))
    .mutation(async ({ ctx, input }) => {
      const app = await updateApp(ctx.prisma, input.id, input.data)
      const resolvedVolumes = await resolvePlaceMounts(ctx.prisma, input.data.volumes)
      const jobId = await publishJob("container.recreate", {
        containerName: app.name,
        image:         app.image,
        ports:         app.ports,
        envs:          app.envs,
        volumes:       resolvedVolumes,
        networkNames:  app.networkNames,
        labels:        app.labels,
        capAdd:        app.capAdd,
        capDrop:       app.capDrop,
        restartPolicy: app.restartPolicy,
        hostname:      app.hostname,
        user:          app.user,
        command:       app.command,
        cpuLimit:      app.cpuLimit,
        memoryLimit:   app.memoryLimit,
      }, ctx.user.userId)
      return { app, jobId }
    }),

  delete: protectedProcedure.use(canDelete)
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const app = await getApp(ctx.prisma, input.id)
      await deleteApp(ctx.prisma, input.id)
      const jobId = await publishJob("container.remove", {
        containerName: app.name,
      }, ctx.user.userId)
      return { jobId }
    }),

  start: protectedProcedure.use(canManage)
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const app = await getApp(ctx.prisma, input.id)
      const jobId = await publishJob("container.start", {
        containerName: app.name,
      }, ctx.user.userId)
      return { jobId }
    }),

  stop: protectedProcedure.use(canManage)
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const app = await getApp(ctx.prisma, input.id)
      const jobId = await publishJob("container.stop", {
        containerName: app.name,
      }, ctx.user.userId)
      return { jobId }
    }),

  restart: protectedProcedure.use(canManage)
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const app = await getApp(ctx.prisma, input.id)
      const jobId = await publishJob("container.restart", {
        containerName: app.name,
      }, ctx.user.userId)
      return { jobId }
    }),

  inspect: protectedProcedure.use(canView)
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const app = await getApp(ctx.prisma, input.id)
      try {
        const result = await requestSync<{ status: string; [k: string]: unknown }>(
          "root.container.inspect",
          { containerName: app.name },
        )
        await setAppStatus(ctx.prisma, input.id, result.status ?? "unknown")
        return result
      } catch (e: any) {
        await setAppStatus(ctx.prisma, input.id, "error")
        throw mapWorkerError(e)
      }
    }),

  listUnmanaged: adminProcedure.query(async ({ ctx }) => {
    type DockerContainer = {
      name:         string
      image:        string
      status:       string
      ports:        Array<{ hostPort: number; containerPort: number; protocol: string }>
      labels:       Record<string, string>
      volumes:      Array<{ type: string; source: string; target: string }>
      networkNames: string[]
    }

    let all: DockerContainer[]
    try {
      all = await requestSync<DockerContainer[]>("root.container.listAll", {}, 10_000)
    } catch {
      return []
    }

    const managed     = await listApps(ctx.prisma)
    const managedNames = new Set(managed.map(a => a.name))

    return all
      .filter(c => !managedNames.has(c.name))
      .map(c => ({
        name:           c.name,
        image:          c.image,
        status:         c.status,
        ports:          c.ports         ?? [],
        labels:         c.labels        ?? {},
        volumes:        c.volumes       ?? [],
        networkNames:   c.networkNames  ?? [],
        composeProject: c.labels?.["com.docker.compose.project"] ?? null,
        composeService: c.labels?.["com.docker.compose.service"] ?? null,
        composeFile:    c.labels?.["com.docker.compose.config-files"] ?? null,
      }))
  }),

  importContainer: adminProcedure
    .input(z.object({
      name:         z.string().min(1).max(64),
      image:        z.string().min(1),
      ports:        z.array(zPortMapping).default([]),
      envs:         z.array(zEnvVar).default([]),
      volumes:      z.array(z.object({
        type:   z.enum(["bind", "named", "place"]),
        source: z.string(),
        target: z.string(),
      })).default([]),
      networkNames: z.array(z.string()).default([]),
      labels:       z.array(zLabelEntry).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const app = await createApp(ctx.prisma, {
        ...input,
        capAdd:        [],
        capDrop:       [],
        restartPolicy: "no",
      })
      await setAppStatus(ctx.prisma, app.id, input.name ? "unknown" : "unknown")
      return app
    }),
})

// ── Network sub-router ────────────────────────────────────────────────────────

const networkRouter = router({
  list: adminProcedure.query(({ ctx }) => listNetworks(ctx.prisma)),

  create: adminProcedure
    .input(z.object({
      name:    z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
      driver:  z.enum(["bridge", "overlay", "host", "none", "macvlan"]).default("bridge"),
      subnet:  z.string().nullable().optional(),
      gateway: z.string().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const network = await createNetwork(ctx.prisma, input)
      const jobId = await publishJob("network.create", {
        networkName: network.name,
        driver:      network.driver,
        subnet:      network.subnet,
        gateway:     network.gateway,
      }, ctx.user.userId)
      return { network, jobId }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const networks = await listNetworks(ctx.prisma)
      const network  = networks.find(n => n.id === input.id)
      if (!network) throw new TRPCError({ code: "NOT_FOUND" })
      await deleteNetwork(ctx.prisma, input.id)
      const jobId = await publishJob("network.remove", {
        networkName: network.name,
      }, ctx.user.userId)
      return { jobId }
    }),
})

// ── Volume sub-router ─────────────────────────────────────────────────────────

const volumeRouter = router({
  list: adminProcedure.query(({ ctx }) => listVolumes(ctx.prisma)),

  create: adminProcedure
    .input(z.object({
      name:       z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
      volumeType: z.enum(["named", "path", "place"]).default("named"),
      sourcePath: z.string().nullable().optional(),
      placeId:    z.string().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const volume = await createVolume(ctx.prisma, input)
      if (volume.volumeType === "named") {
        const jobId = await publishJob("volume.create", {
          volumeName: volume.name,
        }, ctx.user.userId)
        return { volume, jobId }
      }
      return { volume, jobId: null }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const volumes = await listVolumes(ctx.prisma)
      const volume  = volumes.find(v => v.id === input.id)
      if (!volume) throw new TRPCError({ code: "NOT_FOUND" })
      await deleteVolume(ctx.prisma, input.id)
      if (volume.volumeType === "named") {
        const jobId = await publishJob("volume.remove", {
          volumeName: volume.name,
        }, ctx.user.userId)
        return { jobId }
      }
      return { jobId: null }
    }),
})

// ── Main router ───────────────────────────────────────────────────────────────

export const containerRouter = router({
  app:     appRouter,
  network: networkRouter,
  volume:  volumeRouter,
})
