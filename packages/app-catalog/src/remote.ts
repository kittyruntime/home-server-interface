import { zAppManifest, type AppManifest } from "./manifest"

// The catalog index published by the public catalog repository (#26): one
// JSON file listing every app with its icon, signed apart. HSI verifies the
// signature, then keeps each app this version understands: an app needing a
// newer HSI, or that no longer fits the manifest format, is left out on its
// own and the rest of the catalog still applies.

/** Format of the index file itself; a newer one is not read at all. */
export const CATALOG_INDEX_SCHEMA = 1

/** Version of the catalog bundled in this HSI release: an index online replaces it only when newer. */
// Same form as the online index: YYYYMMDDHHmm, UTC.
export const BUNDLED_CATALOG_VERSION = 202611040000

export interface CatalogIndex {
  version: number
  generatedAt: string
  apps: AppManifest[]
  /** Apps left out, with why (shown to administrators). */
  skipped: { id: string; reason: string }[]
}

function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[+-]/)[0]!.split(".").map(n => Number.parseInt(n, 10) || 0)
  const x = parts(a), y = parts(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const MAX_ICON = 64 * 1024

export function parseCatalogIndex(text: string, hsiVersion: string): CatalogIndex {
  let doc: unknown
  try { doc = JSON.parse(text) } catch { throw new Error("the catalog index is not JSON") }
  const d = doc as Record<string, unknown>
  if (!d || typeof d !== "object") throw new Error("the catalog index is not an object")
  if (d.schema !== CATALOG_INDEX_SCHEMA) throw new Error(`catalog index format ${String(d.schema)} is not supported by this HSI`)
  if (!Number.isSafeInteger(d.version) || (d.version as number) <= 0) throw new Error("the catalog index has no version")
  if (typeof d.generatedAt !== "string") throw new Error("the catalog index has no date")
  if (!Array.isArray(d.apps)) throw new Error("the catalog index lists no apps")
  const apps: AppManifest[] = []
  const skipped: { id: string; reason: string }[] = []
  const seen = new Set<string>()
  for (const raw of d.apps as unknown[]) {
    const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
    const id = typeof entry.id === "string" ? entry.id : "?"
    const { icon, minHsiVersion, ...manifest } = entry
    if (typeof minHsiVersion === "string" && compareVersions(hsiVersion, minHsiVersion) < 0) {
      skipped.push({ id, reason: `needs HSI ${minHsiVersion}` })
      continue
    }
    if (typeof icon !== "string" || !icon.trimStart().startsWith("<svg") || icon.length > MAX_ICON) {
      skipped.push({ id, reason: "no usable icon" })
      continue
    }
    const parsed = zAppManifest.safeParse(manifest)
    if (!parsed.success) {
      skipped.push({ id, reason: parsed.error.issues[0]?.message ?? "invalid manifest" })
      continue
    }
    if (seen.has(parsed.data.id)) {
      skipped.push({ id, reason: "listed twice" })
      continue
    }
    seen.add(parsed.data.id)
    apps.push({ ...parsed.data, icon })
  }
  return { version: d.version as number, generatedAt: d.generatedAt, apps, skipped }
}
