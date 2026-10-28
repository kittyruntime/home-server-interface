import { toast } from 'vue-sonner'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastAction {
  label: string
  run: () => void
}

/* Facade over vue-sonner (rendered by <Toaster/> in the dashboard shell), so
   callers keep a three-method API and the durations stay in one place. */
export function useToast() {
  return {
    success: (msg: string) => { toast.success(msg, { duration: 3500 }) },
    error: (msg: string, action?: ToastAction) => {
      toast.error(msg, {
        duration: 7000,
        action: action ? { label: action.label, onClick: () => action.run() } : undefined,
      })
    },
    info: (msg: string) => { toast.info(msg, { duration: 3500 }) },
  }
}
