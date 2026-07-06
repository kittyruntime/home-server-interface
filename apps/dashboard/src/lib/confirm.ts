import { ref } from 'vue'

export interface ConfirmOptions {
  title?: string
  confirmLabel?: string
  danger?: boolean
}

interface ConfirmState extends ConfirmOptions {
  /** Keys the Modal in ConfirmDialog so a replacing request re-mounts it. */
  id: number
  message: string
  resolve: (v: boolean) => void
}

/** Singleton state rendered by a single <ConfirmDialog/> mounted in the dashboard shell. */
export const confirmState = ref<ConfirmState | null>(null)

let nextId = 0

/** Promise-based replacement for window.confirm(), styled like the rest of the app. */
export function useConfirm() {
  function confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
    return new Promise(resolve => {
      // A new confirm() can land while the previous dialog is still animating
      // out (state is only cleared on @close). Settle the old promise so its
      // caller isn't left hanging; extra resolve() calls later are no-ops.
      confirmState.value?.resolve(false)
      confirmState.value = { id: nextId++, message, resolve, ...options }
    })
  }
  return { confirm }
}
