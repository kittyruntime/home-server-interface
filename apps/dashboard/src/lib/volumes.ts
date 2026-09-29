import { ref } from 'vue'
import { trpc } from './trpc'

// Volume holds (#3): what HSI blocked because a data volume is missing, wrong
// or read-only. Shared by the Apps and Sharing views.

export type VolumeHold = Awaited<ReturnType<typeof trpc.storage.volumes.holds.query>>[number]

export function pathUnder(path: string, mountPoint: string): boolean {
  return path === mountPoint || path.startsWith(mountPoint.replace(/\/$/, '') + '/')
}

export function holdLabel(h: VolumeHold): string {
  return h.status === 'back' ? `volume ${h.mountPoint} waiting for Resume` : `volume ${h.mountPoint} ${h.reason}`
}

const holds = ref<VolumeHold[]>([])

export function useVolumeHolds() {
  async function refreshHolds() {
    try {
      holds.value = await trpc.storage.volumes.holds.query()
    } catch {
      holds.value = []
    }
  }
  function holdForPath(path: string): VolumeHold | undefined {
    return holds.value
      .filter(h => pathUnder(path, h.mountPoint))
      .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0]
  }
  function holdForApp(name: string): VolumeHold | undefined {
    return holds.value.find(h => h.stoppedApps.includes(name))
  }
  return { holds, refreshHolds, holdForPath, holdForApp }
}
