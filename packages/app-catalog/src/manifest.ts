import { z } from "zod"

export const zCatalogPort = z.object({
  container:   z.number().int().min(1).max(65535),
  protocol:    z.enum(["tcp", "udp"]).default("tcp"),
  label:       z.string(),
  hostDefault: z.number().int().min(1).max(65535).optional(),
}).strict()
export const zCatalogEnv = z.object({
  key:      z.string(),
  default:  z.string().optional(),
  prompt:   z.string().optional(),
  required: z.boolean().default(false),
  secret:   z.boolean().default(false),
}).strict()
export const zCatalogVolume = z.object({
  target:          z.string().startsWith("/"),
  label:           z.string(),
  suggest:         z.enum(["place", "named", "bind"]).default("place"),
  readOnlyDefault: z.boolean().default(false),
}).strict()
// A pinned image ref: must carry an explicit tag or @sha256 digest, and that
// tag must not be `latest`. Keeps the catalog reproducible (see plan constraints).
const zPinnedImage = z.string().min(1).refine(
  (img) => /@sha256:[a-f0-9]{64}$/.test(img) || (/:[^/]+$/.test(img) && !/:latest$/.test(img)),
  { message: "image must be pinned to a specific tag (not :latest) or a @sha256 digest" },
)
// A service the app needs beside it (database, cache, #26). It is reached by
// its name on the app's network and never publishes a port. An env value can
// quote one of the app's settings as {{KEY}}, e.g. a generated password both
// sides must share.
export const zCatalogSidecar = z.object({
  name:    z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  label:   z.string(),
  image:   zPinnedImage,
  env:     z.record(z.string(), z.string()).default({}),
  volumes: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), target: z.string().startsWith("/") }).strict()).default([]),
  command: z.array(z.string()).optional(),
}).strict()

const SETTING_REF = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g

export const zAppManifest = z.object({
  id:            z.string().regex(/^[a-z0-9-]+$/),
  name:          z.string(),
  category:      z.enum(["Media", "Productivity", "Network", "Downloads", "Developer", "Utilities"]),
  tagline:       z.string().max(120),
  description:   z.string(),
  website:       z.string().url().optional(),
  // Release notes, linked when an update is offered (#26).
  changelog:     z.string().url().startsWith("https://").optional(),
  // Shown on the app's page before installing (#26): its license (SPDX-like
  // short name), source code and documentation.
  license:       z.string().regex(/^[A-Za-z0-9.+-]{2,40}$/).optional(),
  source:        z.string().url().startsWith("https://").optional(),
  docs:          z.string().url().startsWith("https://").optional(),
  // First steps once it runs: first sign-in, where to put files (#26).
  postInstall:   z.array(z.string().min(1).max(300)).max(6).default([]),
  image:         zPinnedImage,
  webUiPort:     z.number().int().min(1).max(65535).optional(),
  ports:         z.array(zCatalogPort).default([]),
  env:           z.array(zCatalogEnv).default([]),
  volumes:       z.array(zCatalogVolume).default([]),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("unless-stopped"),
  services:      z.array(zCatalogSidecar).default([]),
}).strict().superRefine((m, ctx) => {
  const keys = new Set(m.env.map(e => e.key))
  const names = new Set<string>()
  for (const sc of m.services) {
    if (sc.name === m.id || names.has(sc.name)) ctx.addIssue({ code: "custom", message: `duplicate service name ${sc.name}` })
    names.add(sc.name)
    for (const value of Object.values(sc.env)) for (const [, key] of value.matchAll(SETTING_REF)) {
      if (!keys.has(key!)) ctx.addIssue({ code: "custom", message: `${sc.name} refers to unknown setting ${key}` })
    }
  }
})

/** A sidecar env value with its {{KEY}} references replaced by the app's settings. */
export function resolveSettingRefs(value: string, settings: Map<string, string>): string {
  return value.replace(SETTING_REF, (_m, key: string) => settings.get(key) ?? "")
}
export type AppManifest = z.infer<typeof zAppManifest> & { icon: string }
