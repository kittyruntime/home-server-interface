import { getCurrentInstance, onMounted, shallowRef } from 'vue'

/* Native modal dialogs live in the top layer, above everything in <body>.
   Reka UI portals (dropdowns, selects, popovers, tooltips, context menus)
   still render into <body>, so opened from a dialog they would sit behind it
   and be inert. A portal declared inside a dialog targets that dialog
   instead. The target is read once, when the portal mounts, from where the
   component sits in the DOM: it never changes while the dialog is leaving.
   Goes away once the overlays use the Popover API. */
export function useOverlayHost() {
  const target = shallowRef<HTMLElement | 'body'>('body')
  const instance = getCurrentInstance()
  onMounted(() => {
    const anchor = instance?.vnode.el as Node | null | undefined
    const dialog = anchor?.parentElement?.closest<HTMLElement>('dialog')
    if (dialog) target.value = dialog
  })
  return target
}

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
