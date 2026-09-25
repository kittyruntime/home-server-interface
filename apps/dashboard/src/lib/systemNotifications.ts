import { ref } from 'vue'
import { trpc } from './trpc'

export interface SystemNotification {
  id: string
  severity: string
  source: string
  target: string
  message: string
  eventType: string
  createdAt: string
  readAt: string | null
}

const items = ref<SystemNotification[]>([])
const unread = ref(0)
let started = false

// One poller for the whole app (bell badge + menu share it).
export function useSystemNotifications() {
  if (!started) {
    started = true
    void refresh()
    setInterval(() => { void refresh() }, 60_000)
  }
  async function refresh() {
    try {
      const data = await trpc.notifications.list.query()
      items.value = data.items
      unread.value = data.unread
    } catch { /* logged out / transient - keep last state */ }
  }
  async function markAllRead() {
    await trpc.notifications.markAllRead.mutate()
    await refresh()
  }
  return { items, unread, refresh, markAllRead }
}
