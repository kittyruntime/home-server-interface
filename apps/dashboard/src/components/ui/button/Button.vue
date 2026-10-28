<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { ButtonVariants } from "."
import { computed, useAttrs } from "vue"
import { cn } from "@/lib/utils"
import { Primitive } from "reka-ui"
import Tip from "../Tip.vue"
import { buttonVariants } from "."

defineOptions({ inheritAttrs: false })

interface Props extends PrimitiveProps {
  variant?: ButtonVariants["variant"]
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
  /** Tooltip text. An icon-only button still needs its own aria-label, and a
      disabled one shows no tooltip: wrap it in <Tip wrap> for that. */
  tooltip?: string
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
})

const attrs = useAttrs()
const bindings = computed(() => ({
  ...attrs,
  "data-slot": "button",
  "data-variant": props.variant,
  "data-size": props.size,
  "as": props.as,
  "asChild": props.asChild,
  "class": cn(buttonVariants({ variant: props.variant, size: props.size }), props.class),
}))
</script>

<template>
  <!-- Without a tooltip the button stays the root element, so triggers using as-child get it directly -->
  <Tip v-if="tooltip" :text="tooltip">
    <Primitive v-bind="bindings"><slot /></Primitive>
  </Tip>
  <Primitive v-else v-bind="bindings"><slot /></Primitive>
</template>
