import { shallowRef } from 'vue'
import { trpc } from '../../lib/trpc'

// What the host has of ZFS (pools, datasets, watched pools), shared by the
// ZFS tab's sections and the Storage panel. Loaded on demand, again after a
// plan changed it.
export type ZfsInfo = Awaited<ReturnType<typeof trpc.storage.zfs.list.query>>
export type ZfsPool = ZfsInfo['pools'][number]
export type ZfsDataset = ZfsInfo['datasets'][number]

export const zfs = shallowRef<ZfsInfo | null>(null)
export const zfsError = shallowRef<string | null>(null)

export async function loadZfs(): Promise<ZfsInfo | null> {
  try {
    zfs.value = await trpc.storage.zfs.list.query()
    zfsError.value = null
  } catch (e) {
    zfsError.value = (e as Error).message || 'error'
  }
  return zfs.value
}

export const isWatched = (info: ZfsInfo, pool: ZfsPool) => info.watched.some(w => w.guid === pool.guid)

/** The pool's capacity used, in percent. */
export const poolUsedPct = (p: ZfsPool) => (p.size ? Math.round((p.alloc / p.size) * 100) : 0)
