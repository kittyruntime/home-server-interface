import { buttonVariants } from "../button"

export { default as Toggle } from "./Toggle.vue"

export interface ToggleVariants {
  variant?: "default" | "outline"
  size?: "default" | "sm" | "lg"
}

const variants: Record<NonNullable<ToggleVariants["variant"]>, "ghost" | "outline"> = {
  default: "ghost",
  outline: "outline",
}

// A pressed button is a daisyUI btn with aria-pressed (or aria-checked), which
// daisyUI already draws as active.
export function toggleVariants({ variant = "default", size = "default" }: ToggleVariants = {}): string {
  return buttonVariants({ variant: variants[variant], size })
}
