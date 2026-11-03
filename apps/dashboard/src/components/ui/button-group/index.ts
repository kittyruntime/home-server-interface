export { default as ButtonGroup } from "./ButtonGroup.vue"

export interface ButtonGroupVariants {
  orientation?: "horizontal" | "vertical"
}

// Callers pass plain children (buttons, inputs), so join-item goes on every
// direct child instead of asking each one for the class.
const orientations: Record<NonNullable<ButtonGroupVariants["orientation"]>, string> = {
  horizontal: "join-horizontal",
  vertical: "join-vertical",
}

const base = "join w-fit *:join-item [&>input]:flex-1 has-[>[data-slot=button-group]]:gap-2"

export function buttonGroupVariants({ orientation = "horizontal" }: ButtonGroupVariants = {}): string {
  return `${base} ${orientations[orientation]}`
}
