import { z } from "zod"
import crypto from "node:crypto"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, adminProcedure } from "../index"
import { CATALOG } from "@app/app-catalog"
import { portDomainUrl, generateComposeYaml, type AppInput } from "@app/compose"
import { publishJob, requestSync } from "../../nats"
import { listStacks, stackExists, writeStack } from "../../services/containerStacks"
import { resolvePlaceMounts } from "./container"

const zInstallVolume = z.object({
  target: z.string().startsWith("/"),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("place"),    placeId: z.string() }),
    z.object({ kind: z.literal("newPlace"), name: z.string().min(1), path: z.string().startsWith("/") }),
    z.object({ kind: z.literal("bind"),     path: z.string().startsWith("/") }),
    z.object({ kind: z.literal("named"),    name: z.string().min(1) }),
  ]),
})

export const catalogRouter = router({
  list: protectedProcedure.query(async () => {
    // Enrich every manifest with its installed instance (if any): a declarative
    // stack carrying the `hsi.catalog.id` label. We surface the live `status`
    // and the web-UI host port so the store card can show a real state + an
    // Open action, not just an installed/not-installed boolean.
    const stacks = await listStacks()
    return CATALOG.map((m) => {
      const stack = stacks.find((s) =>
        s.app?.labels.some((l) => l.key === "hsi.catalog.id" && l.value === m.id),
      )
      // The web-UI port row (if any) — carries both the mapped host port (fallback
      // URL) and its optional domain/HTTPS binding (the "Open" URL when set).
      const webRow = stack?.app && m.webUiPort != null
        ? stack.app.ports.find((p) => p.containerPort === m.webUiPort) ?? null
        : null
      const installedApp = stack && stack.app
        ? {
            id:      stack.name,
            name:    stack.name,
            status:  stack.status,
            webPort: webRow?.hostPort ?? null,
            webUrl:  webRow ? portDomainUrl(webRow) : null,
          }
        : null
      return { ...m, installed: !!stack, installedApp }
    })
  }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(({ input }) => {
    const m = CATALOG.find((x) => x.id === input.id)
    if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown app" })
    return m
  }),

  install: adminProcedure
    .input(z.object({
      id:      z.string(),
      name:    z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64),
      ports:   z.array(z.object({ container: z.number().int(), host: z.number().int().min(1).max(65535) })).default([]),
      env:     z.array(z.object({ key: z.string(), value: z.string() })).default([]),
      volumes: z.array(zInstallVolume).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const m = CATALOG.find((x) => x.id === input.id)
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown app" })

      // Fail fast on a name collision before doing any side effects (mkdirp,
      // Place rows) below.
      if (await stackExists(input.name)) {
        throw new TRPCError({ code: "CONFLICT", message: "An app with this name already exists" })
      }

      // Validate the submission only references the manifest's declared items.
      const manifestTargets = new Set(m.volumes.map((v) => v.target))
      for (const v of input.volumes) {
        if (!manifestTargets.has(v.target)) throw new TRPCError({ code: "BAD_REQUEST", message: `Unexpected volume ${v.target}` })
      }
      const manifestPorts = new Set(m.ports.map((p) => p.container))
      for (const p of input.ports) {
        if (!manifestPorts.has(p.container)) throw new TRPCError({ code: "BAD_REQUEST", message: `Unexpected port ${p.container}` })
      }

      // Fail fast on newPlace path collisions before any side effect, so a
      // duplicate path surfaces as a clean CONFLICT instead of an uncaught
      // Prisma P2002 (Place.path is unique) mid-way through resolution — which
      // would leave earlier newPlace dirs/rows orphaned.
      const newPlacePaths = input.volumes.flatMap((v) => (v.source.kind === "newPlace" ? [v.source.path] : []))
      if (new Set(newPlacePaths).size !== newPlacePaths.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Two volumes cannot create a new Place at the same path" })
      }
      if (newPlacePaths.length) {
        const clash = await ctx.prisma.place.findFirst({ where: { path: { in: newPlacePaths } } })
        if (clash) throw new TRPCError({ code: "CONFLICT", message: `A Place already exists at ${clash.path}` })
      }

      // Resolve volumes → VolumeMount-shaped entries. "place" volumes keep the
      // Place id as `source` and get resolved to a real host bind path below
      // via resolvePlaceMounts before generating the compose file.
      const submitted = new Map(input.volumes.map((v) => [v.target, v]))
      const volumes: AppInput["volumes"] = await Promise.all(m.volumes.map(async (mv) => {
        const s = submitted.get(mv.target)?.source
        const readOnly = mv.readOnlyDefault
        if (!s) throw new TRPCError({ code: "BAD_REQUEST", message: `Missing volume ${mv.target}` })
        if (s.kind === "place") {
          const place = await ctx.prisma.place.findUnique({ where: { id: s.placeId } })
          if (!place) throw new TRPCError({ code: "NOT_FOUND", message: "Place not found" })
          return { type: "place" as const, source: place.id, target: mv.target, readOnly }
        }
        if (s.kind === "newPlace") {
          // Creating a new Place (and mkdir-ing arbitrary host paths as root
          // via root.fs.mkdirp — which has NO path-containment check on the
          // worker side) is normally gated behind adminProcedure in place.ts
          // (`place.create` / `place.mkdir`). This mutation is admin-only, but
          // the check stays explicit for defence in depth.
          if (!ctx.user.isAdmin) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can create a new Place during install" })
          }
          await requestSync("root.fs.mkdirp", { path: s.path }) // idempotent
          const place = await ctx.prisma.place.create({ data: { name: s.name, path: s.path } })
          return { type: "place" as const, source: place.id, target: mv.target, readOnly }
        }
        if (s.kind === "bind") return { type: "bind" as const, source: s.path, target: mv.target, readOnly }
        return { type: "named" as const, source: s.name, target: mv.target, readOnly }
      }))

      // Env: manifest defaults, overlaid by submitted values; generate missing secrets.
      const submittedEnv = new Map(input.env.map((e) => [e.key, e.value]))
      const envs = m.env.map((me) => {
        let value = submittedEnv.get(me.key) ?? me.default ?? ""
        if (!value && me.secret) value = crypto.randomBytes(24).toString("base64url")
        // Enforce `required` server-side too — don't rely solely on the wizard
        // disabling Install; a required env with no default/value would launch
        // the container mis-configured.
        if (!value && me.required) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Missing required setting ${me.key}` })
        }
        return { key: me.key, value }
      })

      // Ports: manifest container ports + submitted host ports (default host = container).
      const submittedPorts = new Map(input.ports.map((p) => [p.container, p.host]))
      const ports = m.ports.map((mp) => ({
        containerPort: mp.container,
        hostPort:      submittedPorts.get(mp.container) ?? mp.hostDefault ?? mp.container,
        protocol:      mp.protocol as "tcp" | "udp",
        tls:           false,
      }))

      // Derive the web UI's actual host port from the resolved `ports` list
      // (rather than recomputing the same fallback logic a second time) so the
      // wizard can build `http://<host>:<webPort>` itself — the backend has no
      // notion of the browser's hostname, so `pinnedUrl` is intentionally left
      // unset here (container.app.pin can set it later once the frontend knows
      // the URL).
      const webPort = m.webUiPort != null
        ? ports.find((p) => p.containerPort === m.webUiPort)?.hostPort ?? m.webUiPort
        : undefined

      // Build the AppInput, resolve "place" volumes to real host paths, then
      // write the compose file (the stack's single source of truth).
      const config: AppInput = {
        name:          input.name,
        image:         m.image,
        ports,
        envs,
        volumes,
        networkNames:  [],
        labels:        [{ key: "hsi.catalog.id", value: m.id }],
        capAdd:        [],
        capDrop:       [],
        extraHosts:    [],
        restartPolicy: m.restartPolicy,
        hostname:      null,
        user:          null,
        command:       null,
        cpuLimit:      null,
        memoryLimit:   null,
      }
      const resolvedVolumes = await resolvePlaceMounts(ctx.prisma, config.volumes as any[])
      const yaml = generateComposeYaml({ ...config, volumes: resolvedVolumes as any[] })
      await writeStack(input.name, yaml)

      // Wizard UX: validate the freshly written file, then apply immediately —
      // the worker's compose up job creates+starts the stack.
      await requestSync("root.container.composeValidate", { name: input.name }, 30_000)
      const jobId = await publishJob("container.composeUp", { name: input.name }, ctx.user.userId)

      return { name: input.name, jobId, webPort }
    }),
})
