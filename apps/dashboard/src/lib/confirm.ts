import { ref } from 'vue'

export interface ConfirmOptions {
  title?: string
  confirmLabel?: string
  danger?: boolean
}

interface ConfirmState extends ConfirmOptions {
  message: string
  resolve: (v: boolean) => void
}

/** Singleton state rendered by a single <ConfirmDialog/> mounted in the dashboard shell. */
export const confirmState = ref<ConfirmState | null>(null)

/** Promise-based replacement for window.confirm(), styled like the rest of the app. */
export function useConfirm() {
  function confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
    return new Promise(resolve => {
      confirmState.value = { message, resolve, ...options }
    })
  }
  return { confirm }
}
