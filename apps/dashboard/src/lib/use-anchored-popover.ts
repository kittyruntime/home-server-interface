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
  /** Keep the element shown while `.ui-float` plays its exit. The element must
      then be rendered while `present` is true, not `isOpen`. */
  exit?: boolean
  /** Layers of one group end each other's exit when one of them opens, so a
      fast hover across tooltips never leaves several fading out at once. */
  exitGroup?: string
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

/* Open dismissable popovers, topmost last: Esc closes one at a time. A layer
   leaves it as soon as it closes, so one that is only fading out never takes
   an Esc. */
const stack: symbol[] = []

/* Every open layer, to close the ones nested in a layer that closes. */
const openLayers = new Map<symbol, { el: () => HTMLElement | null, close: () => void }>()

/* Layers fading out, by group, to end them at once when a sibling opens. */
const exiting = new Map<string, Set<() => void>>()

/* The exit is a CSS animation (`ui-float-out`). Its duration plus its delay,
   in ms, or 0 when the element has none. The longhands are lists in step with
   `animation-name` (repeated when shorter), so read them at its index. */
function exitDuration(el: HTMLElement): number {
  const style = getComputedStyle(el)
  const list = (value: string) => value.split(',').map(item => item.trim())
  const at = list(style.animationName).indexOf('ui-float-out')
  if (at === -1) return 0
  const pick = (value: string) => {
    const items = list(value)
    return items[at % items.length] ?? ''
  }
  const ms = (value: string) => (value.endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000) || 0
  return ms(pick(style.animationDuration)) + ms(pick(style.animationDelay))
}

/* A dialog opened above the popover (not one that contains it) owns the
   events inside it: pressing or focusing there must not dismiss the popover. */
function inStackedDialog(target: EventTarget | null, floating: HTMLElement): boolean {
  if (!(target instanceof Element)) return false
  const dialog = target.closest('dialog')
  return !!dialog && !dialog.contains(floating)
}

/* Anchored overlay on the Popover API. The element bound to `floating` must
   carry a `popover` attribute and be rendered while `present` is true (or
   `isOpen`, without an exit, or always); it is shown in the top layer, so no
   desktop window or scrolling container clips it, and it stays a DOM
   descendant of where it is declared (an open modal <dialog> therefore does
   not make it inert). Placement is computed by Floating UI with fixed
   positioning; it stops when the layer closes, so the exit plays in place. */
export function useAnchoredPopover(options: AnchoredPopoverOptions = {}) {
  const floating = ref<HTMLElement | null>(null)
  const isOpen = ref(false)
  /* True from the opening until the exit has ended: render the element on it. */
  const present = ref(false)
  const id = Symbol('popover')
  let anchor: PopoverAnchor | null = null
  let opener: HTMLElement | null = null
  let stopAuto: (() => void) | null = null
  let listening = false
  let toggleEl: HTMLElement | null = null
  let announced = false
  let endExit: (() => void) | null = null
  let cancelExit: (() => void) | null = null

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
    if (floating.value !== el || !isOpen.value) return
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, visibility: '' })
    el.dataset.side = placement.split('-')[0]
    el.dataset.placed = ''
    if (!announced) { announced = true; options.onPlaced?.(el) }
  }

  function show() {
    const el = floating.value
    if (!el || !isOpen.value) return
    // Opened inside a layer that has closed meanwhile: it leaves with it
    // rather than staying in the Esc stack.
    if (el.closest('[data-closing]')) { close(false, true); return }
    // A reopening during the exit finds the element still shown: only the
    // positioning needs to start again.
    if (!el.matches(':popover-open')) {
      // The UA popover styles (centered, auto margins) would fight Floating UI.
      Object.assign(el.style, { position: 'fixed', inset: 'auto', margin: '0', left: '0', top: '0', visibility: 'hidden' })
      try { el.showPopover() } catch { /* detached or already shown */ }
    }
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
    // Reopened during the exit: the same element is shown again.
    cancelExit?.()
    if (options.exitGroup) for (const end of [...(exiting.get(options.exitGroup) ?? [])]) end()
    isOpen.value = true
    present.value = true
    listen()
    openLayers.set(id, { el: () => floating.value, close: () => close(false, true) })
  }

  /* Plays the exit with the element still in the top layer, then hides it.
     The element ignores the pointer and the keyboard meanwhile (inert). */
  function startExit(el: HTMLElement | null, instant: boolean) {
    if (!el || instant || !options.exit || !el.matches(':popover-open') || !('placed' in el.dataset)) {
      try { if (el?.matches(':popover-open')) el.hidePopover() } catch { /* already hidden */ }
      present.value = false
      return
    }
    // A dialog under it reads data-dismissable-layer to tell whether Esc or a
    // press belongs to a layer: a fading one must not count.
    const dismissable = el.hasAttribute('data-dismissable-layer')
    el.setAttribute('data-closing', '')
    el.removeAttribute('data-dismissable-layer')
    el.inert = true
    const duration = exitDuration(el)
    if (!duration) {
      el.removeAttribute('data-closing')
      if (dismissable) el.setAttribute('data-dismissable-layer', '')
      el.inert = false
      try { el.hidePopover() } catch { /* already hidden */ }
      present.value = false
      return
    }
    const group = options.exitGroup
    /* A hint popover still in the top layer takes the browser's own Esc (its
       close request) before the dialog under it. End the exit first, in the
       capture phase, so that press reaches the next layer. */
    const onEsc = (event: KeyboardEvent) => { if (event.key === 'Escape') finish() }
    const onEnd = (event: AnimationEvent) => {
      if (event.target === el && event.animationName === 'ui-float-out') finish()
    }
    // The fallback covers an animation that never ends (hidden tab, element
    // the browser took out of the top layer).
    const timer = setTimeout(() => finish(), duration + 100)
    function stopWaiting() {
      clearTimeout(timer)
      el!.removeEventListener('animationend', onEnd)
      document.removeEventListener('keydown', onEsc, true)
      if (group) {
        const ending = exiting.get(group)
        ending?.delete(finish)
        if (ending && ending.size === 0) exiting.delete(group)
      }
      endExit = null
      cancelExit = null
    }
    function finish() {
      stopWaiting()
      try { if (el!.matches(':popover-open')) el!.hidePopover() } catch { /* already hidden */ }
      present.value = false
    }
    el.addEventListener('animationend', onEnd)
    document.addEventListener('keydown', onEsc, true)
    if (group) {
      if (!exiting.has(group)) exiting.set(group, new Set())
      exiting.get(group)!.add(finish)
    }
    endExit = finish
    cancelExit = () => {
      stopWaiting()
      el.removeAttribute('data-closing')
      if (dismissable) el.setAttribute('data-dismissable-layer', '')
      el.inert = false
    }
  }

  /* `instant` skips the exit: for a layer nested in one that closes, which
     leaves with it. */
  function close(restore = true, instant = false) {
    if (!isOpen.value) return
    const el = floating.value
    if (restore && options.restoreFocus !== false && el) {
      const active = document.activeElement
      if (!active || active === document.body || el.contains(active)) {
        const back = anchor instanceof HTMLElement ? anchor : opener
        if (back?.isConnected) back.focus({ preventScroll: true })
      }
    }
    // Layers opened from inside this one (a submenu, a menu in a popover) go
    // with it: left open, they would keep taking Esc while this one fades.
    if (el) for (const [other, layer] of openLayers) if (other !== id && layer.el() && el.contains(layer.el())) layer.close()
    stopPositioning()
    unlisten()
    openLayers.delete(id)
    isOpen.value = false
    startExit(el, instant)
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
    openLayers.delete(id)
    // The element leaves the DOM with its owner: no animation left to wait for.
    const el = floating.value
    endExit?.()
    try { if (el?.matches(':popover-open')) el.hidePopover() } catch { /* already hidden */ }
  })

  return { floating: floating as Ref<HTMLElement | null>, open, close, isOpen, present }
}
