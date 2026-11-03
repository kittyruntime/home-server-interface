import type { ComputedRef, InjectionKey } from "vue"
import type { ToggleVariants } from "../toggle"

export interface ToggleGroupContext {
  variant: ComputedRef<ToggleVariants["variant"]>
  size: ComputedRef<ToggleVariants["size"]>
  spacing: ComputedRef<number>
  single: ComputedRef<boolean>
  disabled: ComputedRef<boolean>
  /** Whether the value is currently pressed. */
  isOn: (value: string) => boolean
  /** Presses or releases the value, following the group's type. */
  toggle: (value: string) => void
  /** Value of the one item reachable with Tab, null when focus is not roving. */
  stop: ComputedRef<string | null>
}

export const toggleGroupKey: InjectionKey<ToggleGroupContext> = Symbol("toggleGroup")
