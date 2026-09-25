import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../lib/trpc'

type Alert = { id: string; source: string; target: string; message: string }

const alerts = ref<Alert[]>([])
let timer: ReturnType<typeof setInterval> | null = null
let refCount = 0

async function fetchAlerts() {
  try { alerts.value = await trpc.alert.list.query() as Alert[] }
  catch { /* non-admin/non-storage-capability, or transient error — leave last-known state */ }
}

/** Module-level singleton (same pattern as apps/dashboard/src/lib/uploads.ts's `tasks`):
 *  every caller shares one 60s poll instead of one per component instance. */
export function useAlerts() {
  onMounted(() => {
    refCount++
    if (refCount === 1) {
      fetchAlerts()
      timer = setInterval(fetchAlerts, 60_000)
    }
  })
  onUnmounted(() => {
    refCount--
    if (refCount === 0 && timer) { clearInterval(timer); timer = null }
  })

  function hasAlerts(prefix: string): boolean {
    return alerts.value.some(a => a.source.startsWith(prefix))
  }

  return { alerts, hasAlerts, refresh: fetchAlerts }
}
