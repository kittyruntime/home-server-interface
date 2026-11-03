import type { ComputedRef, InjectionKey, Ref } from "vue"

export interface TabsContext {
  baseId: string
  orientation: ComputedRef<"horizontal" | "vertical">
  activationMode: ComputedRef<"automatic" | "manual">
  /** Value of the selected tab, undefined when none. */
  model: ComputedRef<string | undefined>
  select: (value: string) => void
  /** The tablist element, where triggers are looked up. */
  listEl: Ref<HTMLElement | null>
  /** Value of the one trigger reachable with Tab, null when none. */
  stop: ComputedRef<string | null>
  focused: Ref<string | null>
  /** Rescans the tablist for triggers, call after one mounts, updates or goes. */
  refresh: () => void
}

export const tabsKey: InjectionKey<TabsContext> = Symbol("tabs")

/** Stable ids so aria-controls and aria-labelledby stay pairs. */
export function makeId(baseId: string, kind: "trigger" | "content", value: string) {
  return `${baseId}-${kind}-${value}`
}
