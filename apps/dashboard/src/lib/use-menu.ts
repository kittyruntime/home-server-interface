import type { Placement } from '@floating-ui/dom'
import { inject, onBeforeUnmount, provide, shallowRef, useId, watch, type InjectionKey, type MaybeRefOrGetter, type Ref, type ShallowRef } from 'vue'
import { nextIndex, typeaheadIndex } from './menu-navigation'
import { useAnchoredPopover, type PopoverAnchor } from './use-anchored-popover'

/* Shared by the dropdown and the context menu: one context per menu level
   (the root, then each submenu), provided to the components below it. */

/* `none` keeps focus where it is, for a submenu opened by hover. */
export type MenuFocus = 'content' | 'first' | 'none'

export interface MenuContext {
  kind: 'dropdown' | 'context'
  isSub: boolean
  parent: MenuContext | null
  root: MenuContext
  open: Ref<boolean>
  /** What the content is placed against: an element, or a point for a context menu. */
  anchor: ShallowRef<PopoverAnchor | null>
  /** The element that opens the menu (a dropdown's button, a context menu's region). */
  trigger: ShallowRef<HTMLElement | null>
  /** Where focus goes once the content is shown. */
  focus: MenuFocus
  triggerId: string
  contentId: string
  /** Set by the mounted content: closes it and gives focus back. */
  closeContent: (() => void) | null
  /** Open against an anchor; against a new one while open, it moves the content. */
  show: (anchor: PopoverAnchor, focus: MenuFocus) => void
  /** Close the whole menu, submenus included. */
  dismiss: () => void
}

const menuKey: InjectionKey<MenuContext> = Symbol('menu')

export interface RadioGroupContext {
  value: () => string | undefined
  select: (value: string) => void
}
export const radioGroupKey: InjectionKey<RadioGroupContext> = Symbol('menu-radio-group')

export function useMenu(init: { kind?: MenuContext['kind'], open: Ref<boolean>, isSub?: boolean }): MenuContext {
  const parent = inject(menuKey, null)
  const ctx: MenuContext = {
    kind: init.kind ?? parent?.kind ?? 'dropdown',
    isSub: init.isSub ?? false,
    parent,
    root: null as unknown as MenuContext,
    open: init.open,
    anchor: shallowRef(null),
    trigger: shallowRef(null),
    focus: 'content',
    triggerId: useId(),
    contentId: useId(),
    closeContent: null,
    show(anchor, focus) {
      ctx.focus = focus
      ctx.anchor.value = anchor
      ctx.open.value = true
    },
    dismiss() {
      if (ctx.root.closeContent) ctx.root.closeContent()
      else ctx.root.open.value = false
    },
  }
  ctx.root = init.isSub && parent ? parent.root : ctx
  provide(menuKey, ctx)
  return ctx
}

export function useMenuContext(): MenuContext {
  const ctx = inject(menuKey, null)
  if (!ctx) throw new Error('Menu components must be used inside a menu root')
  return ctx
}

const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'

export function isMenuItemDisabled(item: HTMLElement): boolean {
  return item.getAttribute('aria-disabled') === 'true'
}

/* The items of one menu level: the ones of an open submenu belong to it. */
export function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEMS)).filter(item => item.closest('[role="menu"]') === menu)
}

function itemLabel(item: HTMLElement): string {
  return (item.dataset.textValue ?? item.textContent ?? '').trim()
}

interface MenuContentOptions {
  placement: MaybeRefOrGetter<Placement>
  offset: () => number
  alignOffset: () => number
}

/* Open state, placement, focus and keyboard of a menu's content. The element
   bound to `floating` carries role="menu" and the popover attribute. */
export function useMenuContent(ctx: MenuContext, options: MenuContentOptions) {
  let query = ''
  let queryTimer: ReturnType<typeof setTimeout> | undefined

  const popover = useAnchoredPopover({
    placement: options.placement,
    offset: options.offset,
    alignOffset: options.alignOffset,
    dismiss: true,
    captureEscape: true,
    closeOnFocusOutside: true,
    /* A right-click inside the trigger moves a context menu: its contextmenu
       event reopens it, so the press must not close it first. */
    ignorePointerdown: event =>
      ctx.kind === 'context' && !ctx.isSub && event.button === 2
      && !!ctx.trigger.value && ctx.trigger.value.contains(event.target as Node),
    onPlaced: (el) => {
      if (ctx.focus === 'first') menuItems(el).find(item => !isMenuItemDisabled(item))?.focus({ preventScroll: true })
      else if (ctx.focus === 'content') el.focus({ preventScroll: true })
    },
    onClose: () => { ctx.open.value = false },
  })
  const { floating, open, close, isOpen } = popover

  ctx.closeContent = () => close()
  onBeforeUnmount(() => { clearTimeout(queryTimer); ctx.closeContent = null })

  watch([ctx.open, ctx.anchor], ([value, anchor]) => {
    if (!value || !anchor) { close(); return }
    open(anchor)
  }, { immediate: true, flush: 'post' })

  function focusItem(item: HTMLElement | undefined) {
    item?.focus({ preventScroll: true })
  }

  function typeahead(menu: HTMLElement, key: string) {
    query += key.toLowerCase()
    clearTimeout(queryTimer)
    queryTimer = setTimeout(() => { query = '' }, 500)
    const items = menuItems(menu).filter(item => !isMenuItemDisabled(item))
    const current = items.findIndex(item => item.contains(document.activeElement))
    const repeated = query.length > 1 && [...query].every(char => char === query[0])
    const index = typeaheadIndex(repeated ? query[0] : query, items.map(itemLabel), current)
    if (index !== -1) focusItem(items[index])
  }

  function onKeydown(event: KeyboardEvent) {
    const menu = floating.value
    if (!menu) return
    // The menu is modal for the keyboard: nothing below reacts to these keys.
    event.stopPropagation()
    if (event.key === 'Tab') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'ArrowLeft' && ctx.isSub) {
      event.preventDefault()
      close()
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = menuItems(menu)
      const current = items.findIndex(item => item.contains(document.activeElement))
      focusItem(items[nextIndex(event.key, current, items.map(isMenuItemDisabled))])
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key !== ' ' || query !== '')) {
      event.preventDefault()
      typeahead(menu, event.key)
    }
  }

  /* Presses, clicks and right-clicks inside the menu stay inside it: the
     content sits in the DOM under rows and windows with their own handlers. */
  function stop(event: Event) {
    event.stopPropagation()
  }

  function onContextmenu(event: Event) {
    event.preventDefault()
    event.stopPropagation()
  }

  return { floating, isOpen, onKeydown, stop, onContextmenu }
}
