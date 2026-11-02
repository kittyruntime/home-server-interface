import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { raiseToasts } from './overlay-host'

const FIELDS = '[autofocus], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [data-slot="dialog-body"] button:not(:disabled), [data-slot="dialog-footer"] button:not(:disabled), [href]'

interface Options {
  /** Return false to refuse a close request (Esc, backdrop, X). */
  canClose?: () => boolean
  /** Whether a click on the dialog's own backdrop closes it. */
  closeOnBackdrop?: () => boolean
  /** Selector of the element to focus first; defaults to the first field. */
  focus?: string
  /** Called once the dialog has closed, after the leave transition. */
  onClosed: () => void
}

/* Shared behavior of the native <dialog class="modal"> shells (Modal,
   ConfirmDialog, Launchpad). The element opens with showModal() when
   mounted. A close request only flips `open`: the template keeps the
   panel rendered through its leave transition, and `finish` (the
   transition's after-leave hook) then calls close() and reports back. If
   the element is not a <dialog> (Modal inside a desktop window), nothing
   is opened and the caller handles it. */
export function useNativeDialog(el: Ref<HTMLElement | null>, opts: Options) {
  const open = ref(true)
  let downOnBackdrop = false
  let finished = false
  let disposed = false
  let escapeHitLayer = false
  /* Where focus returns. Native close() restores it to the element focused at
     showModal(), but a menu item that is about to unmount is a dead end: fall
     back to the menu's trigger. */
  const opener = document.activeElement as HTMLElement | null
  const menu = opener?.closest('[role="menu"]')
  const triggerId = menu?.getAttribute('aria-labelledby')
  const menuTrigger = triggerId ? document.getElementById(triggerId) : null

  function dialog(): HTMLDialogElement | null {
    return el.value instanceof HTMLDialogElement ? el.value : null
  }

  function requestClose() {
    if (opts.canClose && !opts.canClose()) return
    open.value = false
  }

  function finish() {
    if (finished) return
    finished = true
    const d = dialog()
    if (d?.open) d.close()
    const active = document.activeElement
    if (!d || !active || active === document.body || d.contains(active)) {
      const back = opener?.isConnected ? opener : menuTrigger
      back?.focus()
    }
    opts.onClosed()
  }

  /* Esc: always routed through requestClose so the leave transition plays
     and preventClose is honoured. When a Reka layer (dropdown, select,
     popover) inside the dialog was open at the keydown, that Escape belongs
     to the layer, which closes itself: the dialog stays. */
  function trackEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') escapeHitLayer = !!dialog()?.querySelector('[data-dismissable-layer]')
  }

  function onCancel(event: Event) {
    event.preventDefault()
    if (escapeHitLayer) { escapeHitLayer = false; return }
    requestClose()
  }

  /* A close we did not ask for (Chrome lets a second Esc through without a
     cancel event). Refused closes reopen; otherwise report it. */
  function onNativeClose() {
    const d = dialog()
    if (!d || !open.value || disposed) return
    if (opts.canClose && !opts.canClose()) {
      if (d.isConnected) d.showModal()
      return
    }
    open.value = false
    finish()
  }

  /* A click that starts and ends on the backdrop. A Reka layer open inside
     the dialog dismisses itself on the same press: leave the dialog alone. */
  function onPointerdown(event: PointerEvent) {
    const d = dialog()
    downOnBackdrop = !!d && event.target === d && !d.querySelector('[data-dismissable-layer]')
  }

  function onClick(event: MouseEvent) {
    const d = dialog()
    const hit = downOnBackdrop && event.target === d
    downOnBackdrop = false
    if (hit && opts.closeOnBackdrop?.()) requestClose()
  }

  /* Focus the first field rather than the header's close button. */
  function focusFirst() {
    const d = dialog()
    if (!d) return
    const target = d.querySelector<HTMLElement>(opts.focus ?? FIELDS)
    if (target) target.focus()
    else (d.querySelector<HTMLElement>('[tabindex="-1"]') ?? d).focus()
  }

  onMounted(() => {
    const d = dialog()
    if (!d) return
    window.addEventListener('keydown', trackEscape, true)
    d.showModal()
    raiseToasts()
    focusFirst()
  })

  onBeforeUnmount(() => {
    disposed = true
    window.removeEventListener('keydown', trackEscape, true)
    const d = dialog()
    if (!d) return
    if (d.open) d.close()
  })

  return { open, requestClose, finish, onCancel, onNativeClose, onPointerdown, onClick }
}
