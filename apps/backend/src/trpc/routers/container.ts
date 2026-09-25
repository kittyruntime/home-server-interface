import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, adminProcedure, protectedProcedure } from "../index"
import { publishJob, requestSync } from "../../nats"
import {
  listStacks, getStack, stackExists, writeStack, observedNetworks,
  dockerContainers, type DockerContainerLite,
} from "../../services/containerStacks"
import { assertDockerReady, getDockerStatus, dockerProblem } from "../../services/docker-status"
import {
  generateComposeYaml, parseComposeYaml,
  zAppInput, zPortMapping, zEnvVar, zVolumeMount, zLabelEntry, type AppInput,
} from "@app/compose"

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
export async function resolvePlaceMounts(
  prisma: any,
  volumes: Array<{ type: string; source: string; target: string; readOnly?: boolean }>,
) {
  return Promise.all(volumes.map(async (v) => {
    if (v.type !== "place") return v
    const place = await prisma.place.findUnique({ where: { id: v.source } })
    if (!place) throw new TRPCError({ code: "NOT_FOUND", message: `Place ${v.source} not found` })
    return { ...v, type: "bind" as const, source: place.path }
  }))
}

async function dockerBoundPorts(): Promise<Map<string, string>> {
  const ports = new Map<string, string>()
  for (const c of await dockerContainers()) {
    for (const p of c.ports ?? []) ports.set(`${p.hostPort}/${p.protocol}`, c.name)
  }
  return ports
}

// ── App sub-router ────────────────────────────────────────────────────────────

const appRouter = router({
  list: adminProcedure.query(async () => (await listStacks()).map(s => ({ ...s, id: s.name }))),

  get: adminProcedure.input(z.object({ name: z.string() }))
    .query(async ({ input }) => ({ ...(await getStack(input.name)), id: input.name })),

  create: adminProcedure.input(z.object({ data: zAppInput }))
    .mutation(async ({ ctx, input }) => {
      const data = input.data
      if (await stackExists(data.name)) {
        throw new TRPCError({ code: "CONFLICT", message: "An app with this name already exists" })
      }
      const resolved = await resolvePlaceMounts(ctx.prisma, data.volumes as any[])
      const yaml = generateComposeYaml({ ...data, volumes: resolved as any[] } as AppInput)
      await writeStack(data.name, yaml)
      return { name: data.name }
    }),

  update: adminProcedure.input(z.object({ name: z.string(), data: zAppInput }))
    .mutation(async ({ ctx, input }) => {
      const current = await getStack(input.name)
      const resolved = await resolvePlaceMounts(ctx.prisma, input.data.volumes as any[])
      const yaml = generateComposeYaml({ ...input.data, volumes: resolved as any[] } as AppInput, current.rawYaml)
      await writeStack(input.name, yaml)
      return { name: input.name }
    }),

  saveRaw: adminProcedure.input(z.object({ name: z.string(), content: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const parsed = parseComposeYaml(input.content)
      if (parsed.services.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The file must declare at least one service" })
      }
      await writeStack(input.name, input.content)
      return { name: input.name }
    }),

  apply: adminProcedure.input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertDockerReady()
      await getStack(input.name) // 404 early
      await requestSync("root.container.composeValidate", { name: input.name }, 30_000)
      const jobId = await publishJob("container.composeUp", { name: input.name }, ctx.user.userId)
      return { jobId }
    }),

  start: adminProcedure.input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertDockerReady()
      return { jobId: await publishJob("container.composeUp", { name: input.name }, ctx.user.userId) }
    }),

  stop: adminProcedure.input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertDockerReady()
      return { jobId: await publishJob("container.composeStop", { name: input.name }, ctx.user.userId) }
    }),

  restart: adminProcedure.input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertDockerReady()
      return { jobId: await publishJob("container.composeRestart", { name: input.name }, ctx.user.userId) }
    }),

  remove: adminProcedure.input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertDockerReady()
      return { jobId: await publishJob("container.composeDown", { name: input.name, removeFiles: true }, ctx.user.userId) }
    }),

  inspect: adminProcedure.input(z.object({ name: z.string() }))
    .query(async ({ input }) => {
      try {
        return await requestSync<{ status: string; [k: string]: unknown }>(
          "root.container.inspect", { containerName: input.name })
      } catch (e: any) { throw mapWorkerError(e) }
    }),

  /* NOTE: container logs are NOT a tRPC procedure - they are the HTTP SSE route
     in apps/backend/src/routes/containers.ts (fetched by ContainerLogsPanel.vue
     at /containers/<name>/logs). That route keeps working unchanged: it already
     addresses containers by name. Do not add a logs procedure to the router. */

  listPinned: protectedProcedure.query(async () => {
    const stacks = await listStacks()
    return stacks.filter(s => s.app?.pinnedUrl)
      .map(s => ({ id: s.name, name: s.name, status: s.status, pinnedUrl: s.app!.pinnedUrl! }))
  }),

  pin: adminProcedure.input(z.object({ name: z.string(), pinnedUrl: z.string().url().nullable() }))
    .mutation(async ({ input }) => {
      const current = await getStack(input.name)
      if (!current.app) throw new TRPCError({ code: "BAD_REQUEST", message: "Multi-service apps cannot be pinned from the UI" })
      const yaml = generateComposeYaml({ ...current.app, pinnedUrl: input.pinnedUrl }, current.rawYaml)
      await writeStack(input.name, yaml)
      return { ok: true }
    }),

  // Warn (non-blocking) when a host port is already taken — by another managed
  // app, any Docker container, or a non-Docker host process. Returns a human
  // string in `by` for the UI to show.
  checkPort: adminProcedure
    .input(z.object({
      port:        z.number().int().min(1).max(65535),
      protocol:    z.enum(["tcp", "udp"]).default("tcp"),
      excludeName: z.string().optional(),   // ignore the app currently being edited
    }))
    .query(async ({ input }): Promise<{ inUse: boolean; by: string | null }> => {
      // 1) another HSI-managed app (declarative stack)
      const stacks = await listStacks()
      for (const s of stacks) {
        if (s.name === input.excludeName) continue
        if (s.app?.ports.some(p => p.hostPort === input.port && p.protocol === input.protocol)) {
          return { inUse: true, by: `app "${s.name}"` }
        }
      }
      // 2) any Docker container (managed or unmanaged/compose). The app being
      //    edited runs as a container of the same name — don't flag it against itself.
      const dockerName = (await dockerBoundPorts()).get(`${input.port}/${input.protocol}`)
      if (dockerName && !stacks.some(s => s.name === dockerName && s.name === input.excludeName)) {
        return { inUse: true, by: `container "${dockerName}"` }
      }
      // 3) a non-Docker process holding the port (bind-and-release probe)
      try {
        const probe = await requestSync<{ inUse: boolean }>(
          "root.sys.port.check", { port: input.port, protocol: input.protocol }, 5_000,
        )
        if (probe.inUse) return { inUse: true, by: "another process on the host" }
      } catch { /* worker unavailable — best-effort */ }
      return { inUse: false, by: null }
    }),

  importContainer: adminProcedure
    .input(z.object({
      name:         z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      image:        z.string().min(1),
      ports:        z.array(zPortMapping).default([]),
      envs:         z.array(zEnvVar).default([]),
      volumes:      z.array(zVolumeMount).default([]),
      networkNames: z.array(z.string()).default([]),
      labels:       z.array(zLabelEntry).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      if (await stackExists(input.name)) throw new TRPCError({ code: "CONFLICT", message: "An app with this name already exists" })
      const resolved = await resolvePlaceMounts(ctx.prisma, input.volumes as any[])
      const yaml = generateComposeYaml({
        name: input.name, image: input.image, ports: input.ports, envs: input.envs,
        volumes: resolved as any[], networkNames: input.networkNames, labels: input.labels,
        capAdd: [], capDrop: [], extraHosts: [], restartPolicy: "no",
        hostname: null, user: null, command: null, cpuLimit: null, memoryLimit: null, pinnedUrl: null,
      } as AppInput)
      await writeStack(input.name, yaml)
      return { name: input.name }
    }),

  listUnmanaged: adminProcedure.query(async () => {
    type DockerContainer = {
      name:         string
      image:        string
      status:       string
      ports:        Array<{ hostPort: number; containerPort: number; protocol: string }>
      labels:       Record<string, string>
      volumes:      Array<{ type: string; source: string; target: string }>
      networkNames: string[]
    }

    const [all, stacks] = await Promise.all([
      requestSync<DockerContainer[]>("root.container.listAll", {}, 10_000).catch(() => [] as DockerContainer[]),
      listStacks(),
    ])

    const managedNames = new Set<string>()
    for (const s of stacks) {
      managedNames.add(s.name)
      for (const o of s.observed) managedNames.add(o.name)
    }

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
})

// ── Network sub-router ────────────────────────────────────────────────────────

const networkRouter = router({
  list: adminProcedure.query(() => observedNetworks()),
})

// ── Main router ───────────────────────────────────────────────────────────────

export const containerRouter = router({
  // Whether apps can run on this server; `problem` is the message to show.
  dockerStatus: adminProcedure.query(async () => {
    const status = await getDockerStatus(true)
    return { ...status, problem: dockerProblem(status) }
  }),
  app:     appRouter,
  network: networkRouter,
})

export type { DockerContainerLite }
