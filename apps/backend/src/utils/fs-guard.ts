import { realpath } from "node:fs/promises"
import path from "node:path"

// resolveExisting walks up from p until it finds an existing ancestor,
// resolves symlinks on that ancestor, then re-joins the (possibly
// non-existing) tail. Mirrors the equivalent helper in the root-worker
// (apps/root-worker/fs.go) used for the same purpose on impersonated ops.
async function resolveExisting(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    const dir = path.dirname(p)
    if (dir === p) throw new Error(`invalid path: ${p}`)
    const realDir = await resolveExisting(dir)
    return path.join(realDir, path.basename(p))
  }
}

/**
 * Verifies that p (after resolving symlinks on its existing ancestors)
 * lies within root. Used on the rare paths where the backend process
 * touches the filesystem directly instead of delegating to root-worker
 * (e.g. a user with Place access but no mapped Linux user) — those reads
 * are exposed to the same symlink-escape trick the worker guards against.
 */
export async function isWithinRoot(p: string, root: string): Promise<boolean> {
  try {
    const realRoot = await realpath(root)
    const real = await resolveExisting(p)
    return real === realRoot || real.startsWith(realRoot + path.sep)
  } catch {
    return false
  }
}
