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
  /** Set on a task result: the user it belongs to. */
  userId?: string | null
  /** The folder a task result opens. */
  link?: string | null
}

const items = ref<SystemNotification[]>([])
const unread = ref(0)
let started = false

// One poller for the whole app (bell badge + menu share it).
export function useSystemNotifications() {
  if (!started) {
    started = true
    void refresh()
    // A hidden tab skips its turn; the next visible one catches up.
    setInterval(() => { if (!document.hidden) void refresh() }, 60_000)
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
  async function clear() {
    await trpc.notifications.clear.mutate()
    await refresh()
  }
  async function markRead(id: string) {
    const n = items.value.find(i => i.id === id)
    if (!n || n.readAt) return
    // Shown as read at once; the next refresh confirms it.
    n.readAt = new Date().toISOString()
    unread.value = Math.max(0, unread.value - 1)
    try { await trpc.notifications.markRead.mutate({ id }) } finally { void refresh() }
  }
  return { items, unread, refresh, markAllRead, markRead, clear }
}
