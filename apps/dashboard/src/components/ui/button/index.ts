export { default as Button } from "./Button.vue"

export interface ButtonVariants {
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
  size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg"
}

const variants: Record<NonNullable<ButtonVariants["variant"]>, string> = {
  default: "btn btn-primary",
  destructive: "btn btn-error",
  outline: "btn btn-outline",
  secondary: "btn",
  ghost: "btn btn-ghost",
  link: "btn btn-link",
}

const sizes: Record<NonNullable<ButtonVariants["size"]>, string> = {
  "default": "",
  "xs": "btn-xs",
  "sm": "btn-sm",
  "lg": "btn-lg",
  "icon": "btn-square",
  "icon-xs": "btn-square btn-xs",
  "icon-sm": "btn-square btn-sm",
  "icon-lg": "btn-square btn-lg",
}

// Icons without a size-* class stay 1rem, whatever the button size
const base = "whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

export function buttonVariants({ variant = "default", size = "default" }: ButtonVariants = {}): string {
  return [base, variants[variant], sizes[size]].filter(Boolean).join(" ")
}
