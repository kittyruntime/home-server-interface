import type { InjectionKey, Ref } from "vue"

export interface PopoverContext {
  open: Ref<boolean>
  /** Element the popover is placed against: the anchor if any, else the trigger. */
  anchor: () => HTMLElement | null
  setTrigger: (el: HTMLElement | null) => void
  setAnchor: (el: HTMLElement | null) => void
  contentId: string
  toggle: () => void
}

export const popoverKey: InjectionKey<PopoverContext> = Symbol("popover")
