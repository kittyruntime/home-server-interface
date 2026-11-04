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
    success: (msg: string, action?: ToastAction) => {
      toast.success(msg, {
        // An action (Undo) needs time to be reached.
        duration: action ? 8000 : 3500,
        action: action ? { label: action.label, onClick: () => action.run() } : undefined,
      })
    },
    error: (msg: string, action?: ToastAction) => {
      toast.error(msg, {
        duration: 7000,
        action: action ? { label: action.label, onClick: () => action.run() } : undefined,
      })
    },
    info: (msg: string) => { toast.info(msg, { duration: 3500 }) },
  }
}
