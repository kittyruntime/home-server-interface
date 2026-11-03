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

// A pressed button is a daisyUI btn with aria-pressed (or aria-checked). daisyUI
// draws that as active in the button color; the primary color makes it stand out
// from the unpressed state in every theme. Not data-state: Tip overwrites it.
// daisyUI sets a ghost button's --btn-bg to transparent in a later layer than its
// pressed rule, so the fill is also set here (utilities win over components).
// Class names stay literal so Tailwind can see them.
const pressed = "aria-pressed:[--btn-color:var(--color-primary)] aria-pressed:[--btn-fg:var(--color-primary-content)] aria-pressed:[--btn-bg:color-mix(in_oklab,var(--color-primary),#000_5%)] aria-checked:[--btn-color:var(--color-primary)] aria-checked:[--btn-fg:var(--color-primary-content)] aria-checked:[--btn-bg:color-mix(in_oklab,var(--color-primary),#000_5%)]"

export function toggleVariants({ variant = "default", size = "default" }: ToggleVariants = {}): string {
  return `${buttonVariants({ variant: variants[variant], size })} ${pressed}`
}
