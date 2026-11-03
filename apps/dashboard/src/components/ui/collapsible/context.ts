import type { ComputedRef, InjectionKey } from "vue"

export interface CollapsibleContext {
  contentId: string
  open: ComputedRef<boolean>
  disabled: ComputedRef<boolean>
  toggle: () => void
}

export const collapsibleKey: InjectionKey<CollapsibleContext> = Symbol("collapsible")
