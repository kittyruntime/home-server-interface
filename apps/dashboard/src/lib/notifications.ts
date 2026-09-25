import { ref } from 'vue'
import { useToast } from './toast'

export type NotifType = 'progress' | 'success' | 'error' | 'info'

export interface Notification {
  id: string
  type: NotifType
  title: string
  detail?: string
  /** -1 = indeterminate spinner, 0-100 = real progress, undefined = no bar */
  progress?: number
}

const items = ref<Notification[]>([])
const toast = useToast()
let seq = 0

export function useNotifications() {
  function push(n: Omit<Notification, 'id'>, autoDismissMs?: number): string {
    const id = String(seq++)
    items.value.push({ id, ...n })
    if (autoDismissMs != null) setTimeout(() => dismiss(id), autoDismissMs)
    return id
  }

  function update(id: string, patch: Partial<Omit<Notification, 'id'>>) {
    const n = items.value.find(x => x.id === id)
    if (n) Object.assign(n, patch)
  }

  function dismiss(id: string) {
    const i = items.value.findIndex(x => x.id === id)
    if (i >= 0) items.value.splice(i, 1)
  }

  /** Run an async operation tracked as a progress → success/error notification. */
  async function track<T>(title: string, op: () => Promise<T>): Promise<T> {
    const id = push({ type: 'progress', title, progress: -1 })
    try {
      const result = await op()
      update(id, { type: 'success', progress: undefined })
      setTimeout(() => dismiss(id), 3000)
      return result
    } catch (e: any) {
      const detail = e?.message ?? 'Unknown error'
      update(id, { type: 'error', detail, progress: undefined })
      // Errors must be seen without opening the bell menu.
      toast.error(`${title} failed: ${detail}`)
      throw e
    }
  }

  /** Run multiple operations in parallel, showing batched progress. */
  async function trackBatch<T>(
    title: string,
    ops: Array<() => Promise<T>>
  ): Promise<PromiseSettledResult<T>[]> {
    if (ops.length === 0) return []
    const id = push({ type: 'progress', title: `${title} (0 / ${ops.length})`, progress: 0 })
    let done = 0
    const results = await Promise.allSettled(
      ops.map(op =>
        op().then(
          r  => { done++; update(id, { title: `${title} (${done} / ${ops.length})`, progress: Math.round(done / ops.length * 100) }); return r },
          e  => { done++; update(id, { title: `${title} (${done} / ${ops.length})`, progress: Math.round(done / ops.length * 100) }); throw e }
        )
      )
    )
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed === 0) {
      update(id, { type: 'success', title: `${title} — done`, progress: undefined })
      setTimeout(() => dismiss(id), 3000)
    } else {
      const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason
      const detail = firstError instanceof Error ? firstError.message : firstError ? String(firstError) : undefined
      update(id, { type: 'error', title: `${title} — ${failed} failed`, detail, progress: undefined })
      toast.error(`${title}: ${failed} of ${ops.length} failed${detail ? ` (${detail})` : ''}`)
    }
    return results
  }

  function dismissAll() { items.value = [] }

  return { notifications: items, push, update, dismiss, dismissAll, track, trackBatch }
}
