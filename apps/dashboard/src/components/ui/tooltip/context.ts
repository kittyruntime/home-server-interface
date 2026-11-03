import type { InjectionKey, Ref } from "vue"

export const DEFAULT_DELAY = 300
/* Moving from one tooltip to the next within this window skips the delay. */
export const SKIP_DELAY_WINDOW = 300

export const tooltipProviderKey: InjectionKey<{ delayDuration: Ref<number> }> = Symbol("tooltip-provider")

export interface TooltipContext {
  open: Ref<boolean>
  /** True while the content is held closed (its `hidden` prop). */
  suppressed: Ref<boolean>
  contentId: string
  delay: () => number
  anchor: () => HTMLElement | null
  setTrigger: (el: HTMLElement | null) => void
}

export const tooltipKey: InjectionKey<TooltipContext> = Symbol("tooltip")

let lastClosedAt = 0
export function markTooltipClosed() { lastClosedAt = Date.now() }
export function recentlyClosed() { return Date.now() - lastClosedAt < SKIP_DELAY_WINDOW }
