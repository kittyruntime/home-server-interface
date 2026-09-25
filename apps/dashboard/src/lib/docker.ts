import { ref } from 'vue'
import { trpc } from './trpc'

export type DockerStatus = {
  installed: boolean; running: boolean; compose: boolean
  detail?: string; problem: string | null
}

// Shared by the Apps panel and the App Store (module-level, like useAlerts).
const status = ref<DockerStatus | null>(null)
const checking = ref(false)

/** Docker availability on the server. `ready` stays true until a check proves
 *  otherwise, so a failed check never hides the apps UI by mistake. */
export function useDockerStatus() {
  async function check(): Promise<void> {
    checking.value = true
    try {
      status.value = await trpc.container.dockerStatus.query()
    } catch {
      // Unknown (worker unreachable, no permission): keep the last answer.
    } finally {
      checking.value = false
    }
  }
  const ready = () => !status.value || status.value.problem === null
  return { status, checking, check, ready }
}
