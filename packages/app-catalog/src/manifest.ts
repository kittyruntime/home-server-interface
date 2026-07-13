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
export const zAppManifest = z.object({
  id:            z.string().regex(/^[a-z0-9-]+$/),
  name:          z.string(),
  category:      z.enum(["Media", "Productivity", "Network", "Downloads", "Developer", "Utilities"]),
  tagline:       z.string().max(120),
  description:   z.string(),
  website:       z.string().url().optional(),
  image:         zPinnedImage,
  webUiPort:     z.number().int().min(1).max(65535).optional(),
  ports:         z.array(zCatalogPort).default([]),
  env:           z.array(zCatalogEnv).default([]),
  volumes:       z.array(zCatalogVolume).default([]),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("unless-stopped"),
}).strict()
export type AppManifest = z.infer<typeof zAppManifest> & { icon: string }
