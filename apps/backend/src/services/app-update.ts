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

/** Docker Hub names: `docker.io/library/nginx` and `nginx` are the same image. */
function normalRepo(repo: string): string {
  return repo.replace(/^(?:index\.)?docker\.io\//, "").replace(/^library\//, "")
}

function numbers(s: string): number[] {
  return (s.match(/\d+/g) ?? []).map(Number)
}

function compareNumbers(x: number[], y: number[]): number {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Compares two version tags; null when either is not a version or they are
 * not the same variant. A tag is a version (`v1.2.3`, `2024.10.22`) and an
 * optional suffix: its variant (`-alpine`) must match, a commit hash is
 * ignored, and a revision number (`-ls11`) decides between equal versions.
 */
export function compareTags(a: string, b: string): number | null {
  const parse = (t: string) => {
    const m = t.replace(/^v/i, "").match(/^(\d+(?:\.\d+)*)(.*)$/)
    if (!m) return null
    const suffix = m[2]!.replace(/[0-9a-f]{7,40}/g, "")
    return { core: m[1]!.split(".").map(Number), variant: suffix.replace(/\d+/g, "#"), revision: numbers(suffix) }
  }
  const x = parse(a), y = parse(b)
  if (!x || !y || x.variant !== y.variant) return null
  const d = compareNumbers(x.core, y.core)
  if (d !== 0) return d
  const r = compareNumbers(x.revision, y.revision)
  return r !== 0 ? r : a === b ? 0 : null
}

/** The update from the installed image to the catalog's, if the catalog's is a newer tag of the same image. */
export function availableUpdate(installed: string, catalog: string): ImageUpdate | null {
  const i = splitImage(installed), c = splitImage(catalog)
  if (normalRepo(i.repo) !== normalRepo(c.repo) || !i.tag || !c.tag) return null
  const cmp = compareTags(i.tag, c.tag)
  return cmp !== null && cmp < 0 ? { from: i.tag, to: c.tag, image: catalog } : null
}

/** Replaces the one `image:` line naming `from`; anything else in the file (quotes, a comment) is kept as it is. */
export function replaceImage(yaml: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const line = new RegExp(`^([ \\t]*image:[ \\t]*["']?)${escaped}(["']?(?:[ \\t]+#.*)?[ \\t]*)$`, "gm")
  const found = yaml.match(line)?.length ?? 0
  if (found !== 1) {
    throw new Error(found === 0
      ? `The line "image: ${from}" was not found in the compose file; it may have been edited by hand`
      : `The image ${from} is used by ${found} services; update them in the compose editor`)
  }
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
