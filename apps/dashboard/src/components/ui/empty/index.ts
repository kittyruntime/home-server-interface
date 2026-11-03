export { default as Empty } from "./Empty.vue"
export { default as EmptyContent } from "./EmptyContent.vue"
export { default as EmptyDescription } from "./EmptyDescription.vue"
export { default as EmptyHeader } from "./EmptyHeader.vue"
export { default as EmptyMedia } from "./EmptyMedia.vue"
export { default as EmptyTitle } from "./EmptyTitle.vue"

export interface EmptyMediaVariants {
  variant?: "default" | "icon"
}

const base = "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0"

const variants: Record<NonNullable<EmptyMediaVariants["variant"]>, string> = {
  default: "bg-transparent",
  icon: "bg-base-200 text-base-content flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg:not([class*='size-'])]:size-6",
}

export function emptyMediaVariants({ variant = "default" }: EmptyMediaVariants = {}): string {
  return `${base} ${variants[variant]}`
}
