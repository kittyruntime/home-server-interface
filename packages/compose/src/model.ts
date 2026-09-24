import { z } from "zod"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PortMapping {
  hostPort:      number
  containerPort: number
  protocol:      "tcp" | "udp"
  // Optional access binding (HSI-side metadata, never passed to `docker run`):
  // records that this published port is reached at a real URL, e.g. behind the
  // user's own reverse proxy. Drives the "Open" action's URL.
  domain?:       string   // e.g. "jellyfin.example.com"
  tls?:          boolean  // https when true
  publicPort?:   number   // external port; empty => standard 443 (tls) / 80
}

export interface EnvVar {
  key:   string
  value: string
}

export interface VolumeMount {
  type:     "bind" | "named" | "place"
  source:   string
  target:   string
  readOnly: boolean
}

export interface LabelEntry {
  key:   string
  value: string
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

export const zPortMapping = z.object({
  hostPort:      z.number().int().min(1).max(65535),
  containerPort: z.number().int().min(1).max(65535),
  protocol:      z.enum(["tcp", "udp"]).default("tcp"),
  // Optional access binding — records that this port is reached at a real URL
  // (behind the user's own reverse proxy / tunnel). HSI-side metadata only.
  domain:        z.string().min(1).max(253).optional(),
  tls:           z.boolean().default(false),
  publicPort:    z.number().int().min(1).max(65535).optional(),
})

export const zEnvVar = z.object({
  key:   z.string().min(1),
  value: z.string(),
})

export const zVolumeMount = z.object({
  type:     z.enum(["bind", "named", "place"]),
  source:   z.string().min(1),
  target:   z.string().startsWith("/"),
  readOnly: z.boolean().default(false),
})

export const zLabelEntry = z.object({
  key:   z.string().min(1),
  value: z.string(),
})

export const zAppInput = z.object({
  // Lowercase only: Docker Compose v2 lowercases project names, so a
  // mixed-case stack could never match its observed containers.
  name:          z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  image:         z.string().min(1),
  ports:         z.array(zPortMapping).default([]),
  envs:          z.array(zEnvVar).default([]),
  volumes:       z.array(zVolumeMount).default([]),
  networkNames:  z.array(z.string()).default([]),
  labels:        z.array(zLabelEntry).default([]),
  capAdd:        z.array(z.string()).default([]),
  capDrop:       z.array(z.string()).default([]),
  extraHosts:    z.array(z.string().regex(/^[^:]+:[^:]+$/)).default([]),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("no"),
  hostname:      z.string().max(63).nullable().optional(),
  user:          z.string().nullable().optional(),
  command:       z.string().nullable().optional(),
  cpuLimit:      z.number().min(0).max(64).nullable().optional(),
  memoryLimit:   z.string().regex(/^\d+[kmgKMG]?$/).nullable().optional(),
  pinnedUrl:     z.string().url().nullable().optional(),
})

export type AppInput = z.infer<typeof zAppInput>

// ── Helpers ───────────────────────────────────────────────────────────────────

export const STACK_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** A port's access binding -> absolute URL, or null when no domain is set. */
export function portDomainUrl(p: PortMapping): string | null {
  if (!p.domain) return null
  const scheme = p.tls ? "https" : "http"
  const def    = p.tls ? 443 : 80
  const ep     = p.publicPort ?? def
  return ep === def ? `${scheme}://${p.domain}` : `${scheme}://${p.domain}:${ep}`
}
