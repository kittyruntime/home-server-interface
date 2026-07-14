import { z } from "zod"
import crypto from "node:crypto"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure, withPermission } from "../index"
import { CATALOG } from "@app/app-catalog"
import { listApps, createApp, type AppConfig } from "../../services/container.service"
import { publishJob, requestSync } from "../../nats"
import { resolvePlaceMounts } from "./container"

// Same guard manual container creation uses (see container.ts's `canCreate`) —
// `catalog.install` must not be reachable with weaker authorization than
// `container.app.create`, since it ends up calling the exact same service +
// worker job.
const canCreate = withPermission("container.create")

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
  list: protectedProcedure.query(async ({ ctx }) => {
    // Enrich every manifest with its installed instance (if any): a managed app
    // carrying the `hsi.catalog.id` label. We surface the live `status` and the
    // web-UI host port so the store card can show a real state + an Open action,
    // not just an installed/not-installed boolean.
    const apps = await listApps(ctx.prisma)
    return CATALOG.map((m) => {
      const app = apps.find((a) =>
        a.labels.some((l) => l.key === "hsi.catalog.id" && l.value === m.id),
      )
      const webPort = app && m.webUiPort != null
        ? app.ports.find((p) => p.containerPort === m.webUiPort)?.hostPort ?? null
        : null
      const installedApp = app
        ? { id: app.id, name: app.name, status: app.status, webPort }
        : null
      return { ...m, installed: !!app, installedApp }
    })
  }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(({ input }) => {
    const m = CATALOG.find((x) => x.id === input.id)
    if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown app" })
    return m
  }),

  install: protectedProcedure.use(canCreate)
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
      // Place rows) below — createApp() would reject it anyway, but only
      // *after* volumes have already been resolved/created.
      const existing = await ctx.prisma.containerApp.findUnique({ where: { name: input.name } })
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "An app with this name already exists" })

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

      // Resolve volumes → VolumeMount-shaped entries (same shape container.create
      // persists: "place" volumes keep the Place id as `source` and get resolved
      // to a real host bind path later via resolvePlaceMounts, exactly like
      // container.create does).
      const submitted = new Map(input.volumes.map((v) => [v.target, v]))
      const volumes: AppConfig["volumes"] = await Promise.all(m.volumes.map(async (mv) => {
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
          // (`place.create` / `place.mkdir`). `container.create`'s guard here
          // (`container.create` permission) can be granted to non-admins, so
          // to avoid handing a lesser-privileged role a way to create
          // directories/root-owned Places anywhere on the host, require admin
          // specifically for this volume source kind.
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
        protocol:      mp.protocol,
      }))

      // Derive the web UI's actual host port from the resolved `ports` list
      // (rather than recomputing the same fallback logic a second time) so the
      // wizard can build `http://<host>:<webPort>` itself — the backend has no
      // notion of the browser's hostname, so `pinnedUrl` is intentionally left
      // unset here (AppConfig.pinnedUrl stays null; container.app.pin can set
      // it later once the frontend knows the URL).
      const webPort = m.webUiPort != null
        ? ports.find((p) => p.containerPort === m.webUiPort)?.hostPort ?? m.webUiPort
        : undefined

      // Build the SAME AppConfig shape container.create builds, then reuse createApp.
      const config: AppConfig = {
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
      const app = await createApp(ctx.prisma, config)

      // Mirror container.app.create exactly: persisting the row alone does not
      // start anything — the worker only creates+starts the container once it
      // consumes this job off the "root.container.create" JetStream subject.
      const resolvedVolumes = await resolvePlaceMounts(ctx.prisma, app.volumes)
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
        extraHosts:    app.extraHosts,
        restartPolicy: app.restartPolicy,
        hostname:      app.hostname,
        user:          app.user,
        command:       app.command,
        cpuLimit:      app.cpuLimit,
        memoryLimit:   app.memoryLimit,
      }, ctx.user.userId)

      return { app, jobId, webPort }
    }),
})
