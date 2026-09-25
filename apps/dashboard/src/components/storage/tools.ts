import { ref } from 'vue'
import { trpc } from '../../lib/trpc'

export type HostTool = { command: string; package: string; feature: string; available: boolean }

// Commands the Storage app runs; Docker and Samba are reported by their own apps.
const STORAGE_COMMANDS = new Set(['mdadm', 'smartctl', 'pvcreate', 'parted', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.btrfs', 'mkfs.fat'])

const tools = ref<HostTool[]>([])
let loaded: Promise<void> | null = null

/** Host tool availability, fetched once per session and shared by every view. */
export function useHostTools() {
  function load(force = false): Promise<void> {
    if (!loaded || force) {
      loaded = trpc.storage.tools.query()
        .then(r => { tools.value = r.tools })
        .catch(() => { loaded = null }) // unknown: never block actions on a failed check
    }
    return loaded ?? Promise.resolve()
  }

  /** True only when the server confirmed the command is missing. */
  function isMissing(command: string): boolean {
    return tools.value.some(t => t.command === command && !t.available)
  }

  const missingStorageTools = () => tools.value.filter(t => STORAGE_COMMANDS.has(t.command) && !t.available)

  return { tools, load, isMissing, missingStorageTools }
}
