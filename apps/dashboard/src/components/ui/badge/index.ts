export { default as Badge } from "./Badge.vue"

export interface BadgeVariants {
  variant?: "default" | "secondary" | "destructive" | "outline"
}

const variants: Record<NonNullable<BadgeVariants["variant"]>, string> = {
  default: "badge-primary",
  secondary: "badge-ghost",
  destructive: "badge-error",
  outline: "badge-outline border-base-300",
}

// badge-sm keeps the 20px height and 12px text of the dense UI
const base = "badge badge-sm shrink-0 whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"

export function badgeVariants({ variant = "default" }: BadgeVariants = {}): string {
  return `${base} ${variants[variant]}`
}
