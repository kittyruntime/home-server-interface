import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  type: ToastType
  message: string
}

const toasts = ref<Toast[]>([])
let seq = 0

export function useToast() {
  function push(type: ToastType, message: string) {
    const id = String(seq++)
    toasts.value.push({ id, type, message })
    setTimeout(() => dismiss(id), type === 'error' ? 7000 : 3500)
  }

  function dismiss(id: string) {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }

  return {
    toasts,
    success: (msg: string) => push('success', msg),
    error:   (msg: string) => push('error', msg),
    info:    (msg: string) => push('info', msg),
    dismiss,
  }
}
