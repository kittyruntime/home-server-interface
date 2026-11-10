// What a background job works on, stored with its row so the Activity panel
// can say "Copying Films to Archives" without the worker payload.

export type JobKind = "copy" | "move" | "delete" | "zip" | "unzip" | "finalize" | "container" | "other"

export interface JobMeta {
  kind: JobKind
  src?: string
  dst?: string
  name?: string
  count?: number
  /** Housekeeping the user did not ask for (an upload's staging file): never listed. */
  internal?: boolean
}

const FS_KINDS: Record<string, JobKind> = {
  "fs.copy": "copy",
  "fs.move": "move",
  "fs.delete": "delete",
  "fs.zip": "zip",
  "fs.unzip": "unzip",
  "fs.finalize": "finalize",
}

const MAX_TEXT = 1024

export function jobKind(action: string): JobKind {
  if (action.startsWith("container.")) return "container"
  return FS_KINDS[action] ?? "other"
}

const cap = (s: string | undefined) => (s === undefined ? undefined : s.slice(0, MAX_TEXT))

export function encodeJobMeta(meta: JobMeta): string {
  const out: JobMeta = { kind: meta.kind }
  if (meta.src !== undefined) out.src = cap(meta.src)
  if (meta.dst !== undefined) out.dst = cap(meta.dst)
  if (meta.name !== undefined) out.name = cap(meta.name)
  if (meta.count !== undefined) out.count = meta.count
  if (meta.internal) out.internal = true
  return JSON.stringify(out)
}

export function decodeJobMeta(raw: string | null, action: string): JobMeta {
  const fallback: JobMeta = { kind: jobKind(action) }
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw) as Partial<JobMeta> | null
    if (!v || typeof v !== "object") return fallback
    const out: JobMeta = { kind: jobKind(action) }
    if (typeof v.src === "string") out.src = cap(v.src)
    if (typeof v.dst === "string") out.dst = cap(v.dst)
    if (typeof v.name === "string") out.name = cap(v.name)
    if (typeof v.count === "number") out.count = v.count
    if (v.internal === true) out.internal = true
    return out
  } catch {
    return fallback
  }
}
