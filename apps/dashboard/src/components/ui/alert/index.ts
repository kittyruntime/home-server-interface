export { default as Alert } from "./Alert.vue"
export { default as AlertDescription } from "./AlertDescription.vue"

export interface AlertVariants {
  variant?: "default" | "destructive" | "warning" | "info"
}

const variants: Record<NonNullable<AlertVariants["variant"]>, string> = {
  default: "",
  destructive: "alert-error alert-soft text-error",
  warning: "alert-warning alert-soft text-base-content [&>svg]:text-warning",
  info: "alert-info alert-soft text-base-content [&>svg]:text-info",
}

// The icon column stays 1rem wide and the text stacks in the second column
const base = "alert w-full grid-flow-row grid-cols-[0_1fr] items-start justify-items-stretch gap-x-0 gap-y-0.5 has-[>svg]:grid-cols-[1rem_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current"

export function alertVariants({ variant = "default" }: AlertVariants = {}): string {
  return `${base} ${variants[variant]}`.trim()
}
