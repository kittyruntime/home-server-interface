import { autoUpdate, computePosition, flip, offset, shift, type Placement, type VirtualElement } from '@floating-ui/dom'
import { nextTick, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'

export type PopoverAnchor = HTMLElement | { x: number; y: number }

export interface AnchoredPopoverOptions {
  placement?: MaybeRefOrGetter<Placement>
  /** Gap between the anchor and the popover, in px. */
  offset?: MaybeRefOrGetter<number>
  /** Offset along the anchor's edge, in px. */
  alignOffset?: MaybeRefOrGetter<number>
  /** Close on Esc and on a pointer press outside. Off for hover tooltips. */
  dismiss?: boolean
  /** Swallow the Esc that closes it, so a parent dialog stays open. */
  captureEscape?: boolean
  /** Return focus to the anchor when the popover closes with focus inside it. */
  restoreFocus?: boolean
  /** Close when focus moves outside the popover and its anchor. */
  closeOnFocusOutside?: boolean
  /** Called each time the popover closes, whatever the reason. */
  onClose?: () => void
  /** Called once per opening, when the popover is first placed and visible. */
  onPlaced?: (el: HTMLElement) => void
  /** Return true for a press outside that must not dismiss the popover. */
  ignorePointerdown?: (event: PointerEvent) => boolean
}

/* `popover="hint"` is not in every browser: elsewhere fall back to "manual",
   which also leaves other open popovers alone. */
let hintSupported: boolean | undefined
export function popoverHintMode(): 'hint' | 'manual' {
  if (hintSupported === undefined) {
    const probe = document.createElement('div')
    probe.setAttribute('popover', 'hint')
    hintSupported = probe.popover === 'hint'
  }
  return hintSupported ? 'hint' : 'manual'
}

/* Open dismissable popovers, topmost last: Esc closes one at a time. */
const stack: symbol[] = []

/* A dialog opened above the popover (not one that contains it) owns the
   events inside it: pressing or focusing there must not dismiss the popover. */
function inStackedDialog(target: EventTarget | null, floating: HTMLElement): boolean {
  if (!(target instanceof Element)) return false
  const dialog = target.closest('dialog')
  return !!dialog && !dialog.contains(floating)
}

/* Anchored overlay on the Popover API. The element bound to `floating` must
   carry a `popover` attribute and be rendered while `isOpen` is true (or
   always); it is shown in the top layer, so no desktop window or scrolling
   container clips it, and it stays a DOM descendant of where it is declared
   (an open modal <dialog> therefore does not make it inert). Placement is
   computed by Floating UI with fixed positioning. */
export function useAnchoredPopover(options: AnchoredPopoverOptions = {}) {
  const floating = ref<HTMLElement | null>(null)
  const isOpen = ref(false)
  const id = Symbol('popover')
  let anchor: PopoverAnchor | null = null
  let opener: HTMLElement | null = null
  let stopAuto: (() => void) | null = null
  let listening = false
  let toggleEl: HTMLElement | null = null
  let announced = false

  function reference(): HTMLElement | VirtualElement | null {
    if (!anchor) return null
    if (anchor instanceof HTMLElement) return anchor
    const { x, y } = anchor
    return { getBoundingClientRect: () => ({ x, y, width: 0, height: 0, top: y, left: x, right: x, bottom: y }) }
  }

  async function place() {
    const el = floating.value
    const ref = reference()
    if (!el || !ref) return
    const { x, y, placement } = await computePosition(ref, el, {
      strategy: 'fixed',
      placement: toValue(options.placement) ?? 'bottom',
      middleware: [
        offset({ mainAxis: toValue(options.offset) ?? 4, crossAxis: toValue(options.alignOffset) ?? 0 }),
        flip({ padding: 8 }),
        shift({ padding: 8 }),
      ],
    })
    if (floating.value !== el) return
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, visibility: '' })
    el.dataset.side = placement.split('-')[0]
    el.dataset.placed = ''
    if (!announced) { announced = true; options.onPlaced?.(el) }
  }

  function show() {
    const el = floating.value
    if (!el || !isOpen.value || el.matches(':popover-open')) return
    // The UA popover styles (centered, auto margins) would fight Floating UI.
    Object.assign(el.style, { position: 'fixed', inset: 'auto', margin: '0', left: '0', top: '0', visibility: 'hidden' })
    try { el.showPopover() } catch { /* detached or already shown */ }
    // The browser may close a hint itself (e.g. another hint opens).
    el.addEventListener('toggle', onToggle)
    toggleEl = el
    const ref = reference()
    if (ref) stopAuto = autoUpdate(ref, el, () => { void place() })
  }

  function stopPositioning() {
    announced = false
    stopAuto?.()
    stopAuto = null
    toggleEl?.removeEventListener('toggle', onToggle)
    toggleEl = null
  }

  function onToggle(event: Event) {
    if ((event as ToggleEvent).newState === 'closed' && isOpen.value) close(false)
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || stack[stack.length - 1] !== id) return
    if (floating.value && inStackedDialog(event.target, floating.value)) return
    if (options.captureEscape) {
      event.preventDefault()
      event.stopPropagation()
    }
    close()
  }

  function onPointerdown(event: PointerEvent) {
    const el = floating.value
    const target = event.target as Node | null
    if (!el || !target || el.contains(target)) return
    if (anchor instanceof HTMLElement && anchor.contains(target)) return
    if (inStackedDialog(target, el)) return
    if (options.ignorePointerdown?.(event)) return
    // After the event has reached the dialog's own handlers, which read the DOM
    // to tell whether a layer was open at the press.
    setTimeout(() => close())
  }

  function onFocusin(event: FocusEvent) {
    const el = floating.value
    const target = event.target as Node | null
    if (!el || !target || el.contains(target)) return
    if (anchor instanceof HTMLElement && anchor.contains(target)) return
    if (inStackedDialog(target, el)) return
    close(false)
  }

  function listen() {
    if (listening) return
    listening = true
    stack.push(id)
    if (options.dismiss) {
      document.addEventListener('keydown', onKeydown, true)
      document.addEventListener('pointerdown', onPointerdown, true)
    }
    if (options.closeOnFocusOutside) document.addEventListener('focusin', onFocusin, true)
  }

  function unlisten() {
    if (!listening) return
    listening = false
    const at = stack.indexOf(id)
    if (at !== -1) stack.splice(at, 1)
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('pointerdown', onPointerdown, true)
    document.removeEventListener('focusin', onFocusin, true)
  }

  function open(target: PopoverAnchor) {
    anchor = target
    if (isOpen.value) { void place(); return }
    opener = document.activeElement as HTMLElement | null
    isOpen.value = true
    listen()
  }

  function close(restore = true) {
    if (!isOpen.value) return
    const el = floating.value
    if (restore && options.restoreFocus !== false && el) {
      const active = document.activeElement
      if (!active || active === document.body || el.contains(active)) {
        const back = anchor instanceof HTMLElement ? anchor : opener
        if (back?.isConnected) back.focus({ preventScroll: true })
      }
    }
    stopPositioning()
    unlisten()
    try { if (el?.matches(':popover-open')) el.hidePopover() } catch { /* already hidden */ }
    isOpen.value = false
    options.onClose?.()
  }

  // The element appears after isOpen flips (v-if) or is always there.
  watch([floating, isOpen], async () => {
    await nextTick()
    stopPositioning()
    if (isOpen.value && floating.value) show()
  }, { flush: 'post' })

  onBeforeUnmount(() => {
    stopPositioning()
    unlisten()
  })

  return { floating: floating as Ref<HTMLElement | null>, open, close, isOpen }
}
