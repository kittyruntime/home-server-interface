/* A toast layer opened as a popover on mount sits below dialogs opened after
   it (the top layer is ordered by insertion). Re-show it each time a dialog
   opens so toasts stay visible above it. */
export function raiseToasts() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-toast-layer]')) {
    try {
      if (el.matches(':popover-open')) el.hidePopover()
      el.showPopover()
    } catch { /* popover not supported or element detached */ }
  }
}
