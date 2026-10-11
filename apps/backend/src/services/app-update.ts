import { CATALOG, type AppManifest } from "@app/app-catalog"

// App updates (#26): an app installed from the App Store keeps its catalog id
// in the `hsi.catalog.id` label. When the catalog shipped with HSI pins a newer
// tag of the same image, the app can be updated: only the image line of its
// compose file changes.

export interface ImageUpdate { from: string; to: string; image: string }

/** Splits an image reference into repository and tag (a registry port is not a tag). */
export function splitImage(ref: string): { repo: string; tag: string | null } {
  if (ref.includes("@")) return { repo: ref.slice(0, ref.indexOf("@")), tag: null }
  const slash = ref.lastIndexOf("/")
  const colon = ref.lastIndexOf(":")
  if (colon > slash) return { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) }
  return { repo: ref, tag: null }
}

/** Compares two version tags; null when either is not a version or they differ only by a suffix. */
export function compareTags(a: string, b: string): number | null {
  const core = (t: string) => t.replace(/^v/i, "").match(/^(\d+(?:\.\d+)*)/)?.[1]
  const x = core(a), y = core(b)
  if (!x || !y) return null
  const xs = x.split(".").map(Number), ys = y.split(".").map(Number)
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const d = (xs[i] ?? 0) - (ys[i] ?? 0)
    if (d !== 0) return d
  }
  return a === b ? 0 : null
}

/** The update from the installed image to the catalog's, if the catalog's is a newer tag of the same image. */
export function availableUpdate(installed: string, catalog: string): ImageUpdate | null {
  const i = splitImage(installed), c = splitImage(catalog)
  if (i.repo !== c.repo || !i.tag || !c.tag) return null
  const cmp = compareTags(i.tag, c.tag)
  return cmp !== null && cmp < 0 ? { from: i.tag, to: c.tag, image: catalog } : null
}

/** Replaces the one `image:` line naming `from`; anything else in the file is kept as it is. */
export function replaceImage(yaml: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const line = new RegExp(`^(\\s*image:\\s*["']?)${escaped}(["']?\\s*)$`, "gm")
  const found = yaml.match(line)?.length ?? 0
  if (found !== 1) throw new Error(`The image ${from} must appear once in the compose file (found ${found})`)
  return yaml.replace(line, (_m, head: string, tail: string) => `${head}${to}${tail}`)
}

/** The catalog app an installed app came from, from its labels. */
export function catalogEntry(labels: Array<{ key: string; value: string }>, catalog: AppManifest[] = CATALOG): AppManifest | undefined {
  const id = labels.find(l => l.key === "hsi.catalog.id")?.value
  return id ? catalog.find(m => m.id === id) : undefined
}

/** What the Apps and App Store pages show for an installed app. */
export function catalogUpdateFor(app: { image: string; labels: Array<{ key: string; value: string }> } | null): (ImageUpdate & { changelog: string | null }) | null {
  const m = app ? catalogEntry(app.labels) : undefined
  const u = m && app ? availableUpdate(app.image, m.image) : null
  return u ? { ...u, changelog: m!.changelog ?? null } : null
}
