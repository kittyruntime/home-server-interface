import path from "node:path"
import { TRPCError } from "@trpc/server"
import { prisma } from "@app/database"

// Places closed to AI assistants, built-in or over MCP: what they hold is
// never sent to an AI provider. An admin picks them in Settings > AI access.
// Every tool call is checked against them before it runs, and what a tool
// returns is cleared of anything inside them.

export interface Exclusions {
  ids: Set<string>
  /** The Places' folders, normalised, without a trailing slash. */
  paths: string[]
}

export const NO_EXCLUSIONS: Exclusions = { ids: new Set(), paths: [] }

export const EXCLUDED_MESSAGE = "This Place is not open to AI assistants"

export function parseIds(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch { return [] }
}

export async function loadExclusions(): Promise<Exclusions> {
  const row = await prisma.assistantSettings.findUnique({ where: { id: 1 }, select: { excludedPlaceIds: true } })
  const ids = parseIds(row?.excludedPlaceIds)
  if (!ids.length) return NO_EXCLUSIONS
  const places = await prisma.place.findMany({ where: { id: { in: ids } }, select: { id: true, path: true } })
  return { ids: new Set(places.map(p => p.id)), paths: places.map(p => normalise(p.path)) }
}

function normalise(p: string): string {
  const n = path.posix.normalize(p)
  return n.length > 1 ? n.replace(/\/+$/, "") : n
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent === "/" ? "/" : parent + "/")

/** Whether a path is inside an excluded Place. */
export function isExcluded(p: string, ex: Exclusions): boolean {
  if (!ex.paths.length) return false
  const n = normalise(p)
  return ex.paths.some(e => within(n, e))
}

/** Whether a path holds an excluded Place (a change to it would reach inside). */
function holdsExcluded(p: string, ex: Exclusions): boolean {
  const n = normalise(p)
  return ex.paths.some(e => within(e, n))
}

// The arguments that name files or folders, in the tools.
const PATH_ARGS = ["path", "parentPath", "src", "dstDir"] as const

/**
 * Refuses a call that would open an excluded Place: a path inside one, and
 * for a change, a path that holds one (deleting or moving its parent folder
 * would reach its files too). A Place named by id counts for the file tools.
 */
export function checkArgs(args: Record<string, unknown>, o: { changes: boolean; files: boolean }, ex: Exclusions) {
  if (!ex.paths.length) return
  const paths: string[] = []
  for (const k of PATH_ARGS) if (typeof args[k] === "string") paths.push(args[k] as string)
  if (Array.isArray(args.paths)) paths.push(...args.paths.filter((p): p is string => typeof p === "string"))
  for (const p of paths) {
    if (isExcluded(p, ex) || (o.changes && holdsExcluded(p, ex))) throw new TRPCError({ code: "FORBIDDEN", message: EXCLUDED_MESSAGE })
  }
  if (o.files && typeof args.placeId === "string" && ex.ids.has(args.placeId)) throw new TRPCError({ code: "FORBIDDEN", message: EXCLUDED_MESSAGE })
}

/** A tool's result without what lies in an excluded Place (list items with such a path). */
export function filterResult(value: unknown, ex: Exclusions): unknown {
  if (!ex.paths.length) return value
  if (Array.isArray(value)) {
    return value
      .filter(v => !(v && typeof v === "object" && typeof (v as { path?: unknown }).path === "string" && isExcluded((v as { path: string }).path, ex)))
      .map(v => filterResult(v, ex))
  }
  // Plain objects only: a Date or a Buffer is kept as it is.
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, filterResult(v, ex)]))
  }
  return value
}
