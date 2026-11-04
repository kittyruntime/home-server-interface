import { prisma } from "@app/database"
import { requestSync } from "../nats"
import { log } from "../utils/log"

// Per-place trash (#200): what the root worker does with <place>/.hsi-trash,
// and the periodic purge of items older than a place's retention.

export const TRASH_DIR = ".hsi-trash"

export type TrashEntry = {
  id: string; name: string; originalPath: string; deletedAt: string
  deletedBy?: string; type: "file" | "dir"; size: number | null
}

type Place = { id: string; name: string; path: string; trashEnabled: boolean; trashRetentionDays: number | null }

/** The place a path is in: the one with the longest matching path. */
export function placeOf<T extends { path: string }>(places: readonly T[], path: string): T | null {
  let best: T | null = null
  for (const p of places) {
    if ((path === p.path || path.startsWith(p.path + "/")) && (!best || p.path.length > best.path.length)) best = p
  }
  return best
}

/** Whether a listing entry is a place's trash folder, which never shows. */
export function isTrashEntry(entry: { name: string }): boolean {
  return entry.name === TRASH_DIR
}

export function trashRequest<T>(payload: {
  op: "trash" | "list" | "restore" | "delete" | "empty" | "purge"
  placeRoot: string
  linuxUsername?: string
  path?: string
  deletedBy?: string
  ids?: string[]
  target?: string
  olderThanDays?: number
}, timeout = 30_000): Promise<T> {
  return requestSync<T>("root.fs.trash", { linuxUsername: "", ...payload }, timeout)
}

/** Removes trash items older than each place's retention. Runs as root, only inside the trash. */
export async function purgeTrashes(): Promise<void> {
  const places: Place[] = await prisma.place.findMany({ where: { trashEnabled: true, trashRetentionDays: { not: null } } })
  for (const place of places) {
    try {
      const r = await trashRequest<{ removed: number }>(
        { op: "purge", placeRoot: place.path, olderThanDays: place.trashRetentionDays! }, 300_000)
      if (r.removed > 0) log.info({ place: place.name, removed: r.removed }, "trash: emptied old items")
    } catch (e) {
      log.warn({ place: place.name, err: (e as Error).message }, "trash: purge failed")
    }
  }
}

const PURGE_EVERY_MS = 6 * 60 * 60 * 1000

export function startTrashPurge(): void {
  setTimeout(() => { void purgeTrashes() }, 2 * 60 * 1000).unref()
  setInterval(() => { void purgeTrashes() }, PURGE_EVERY_MS).unref()
}
