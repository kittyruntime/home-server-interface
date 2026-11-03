import type { InjectionKey, Ref } from "vue"

export type RadioValue = string | number | boolean

export interface RadioGroupContext {
  name: Ref<string>
  model: Ref<RadioValue | undefined>
  disabled: Ref<boolean>
  required: Ref<boolean>
  /** Bumped after each pick so items rewrite their DOM state to the model. */
  tick: Ref<number>
  select: (value: RadioValue) => void
}

export const radioGroupKey: InjectionKey<RadioGroupContext> = Symbol("radio-group")
