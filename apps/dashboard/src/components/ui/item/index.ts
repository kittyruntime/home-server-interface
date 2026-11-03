export { default as Item } from "./Item.vue"
export { default as ItemDescription } from "./ItemDescription.vue"
export { default as ItemTitle } from "./ItemTitle.vue"

export interface ItemVariants {
  variant?: "default" | "outline" | "muted"
  size?: "default" | "sm"
}

const itemBase = "group/item flex items-center border border-transparent text-sm rounded-md transition-colors [a]:hover:bg-base-200/50 [a]:transition-colors duration-100 flex-wrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"

const itemVariantClasses: Record<NonNullable<ItemVariants["variant"]>, string> = {
  default: "bg-transparent",
  outline: "border-base-300",
  muted: "bg-base-200/50",
}

const itemSizes: Record<NonNullable<ItemVariants["size"]>, string> = {
  default: "p-4 gap-4",
  sm: "py-3 px-4 gap-2.5",
}

export function itemVariants({ variant = "default", size = "default" }: ItemVariants = {}): string {
  return `${itemBase} ${itemVariantClasses[variant]} ${itemSizes[size]}`
}
