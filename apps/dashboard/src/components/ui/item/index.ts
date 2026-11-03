export { default as Item } from "./Item.vue"
export { default as ItemActions } from "./ItemActions.vue"
export { default as ItemContent } from "./ItemContent.vue"
export { default as ItemDescription } from "./ItemDescription.vue"
export { default as ItemFooter } from "./ItemFooter.vue"
export { default as ItemGroup } from "./ItemGroup.vue"
export { default as ItemHeader } from "./ItemHeader.vue"
export { default as ItemMedia } from "./ItemMedia.vue"
export { default as ItemSeparator } from "./ItemSeparator.vue"
export { default as ItemTitle } from "./ItemTitle.vue"

export interface ItemVariants {
  variant?: "default" | "outline" | "muted"
  size?: "default" | "sm"
}

export interface ItemMediaVariants {
  variant?: "default" | "icon" | "image"
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

const mediaBase = "flex shrink-0 items-center justify-center gap-2 group-has-[[data-slot=item-description]]/item:self-start [&_svg]:pointer-events-none group-has-[[data-slot=item-description]]/item:translate-y-0.5"

const mediaVariantClasses: Record<NonNullable<ItemMediaVariants["variant"]>, string> = {
  default: "bg-transparent",
  icon: "size-8 border rounded-sm bg-base-200 [&_svg:not([class*='size-'])]:size-4",
  image: "size-10 rounded-sm overflow-hidden [&_img]:size-full [&_img]:object-cover",
}

export function itemMediaVariants({ variant = "default" }: ItemMediaVariants = {}): string {
  return `${mediaBase} ${mediaVariantClasses[variant]}`
}
