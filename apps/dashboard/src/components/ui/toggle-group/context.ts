import type { ComputedRef, InjectionKey } from "vue"
import type { ToggleVariants } from "../toggle"

/** "tabs" draws the group as a daisyUI tabs-box, the segmented control for one choice. */
export type ToggleGroupVariant = ToggleVariants["variant"] | "tabs"

export interface ToggleGroupContext {
  variant: ComputedRef<ToggleGroupVariant>
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
