<script setup lang="ts">
import type { PrimitiveProps } from "../Primitive.vue"
import type { HTMLAttributes } from "vue"
import type { ButtonGroupVariants } from "."
import { cn } from "@/lib/utils"
import Primitive from "../Primitive.vue"

interface Props extends PrimitiveProps {
  class?: HTMLAttributes["class"]
  orientation?: ButtonGroupVariants["orientation"]
}

const props = withDefaults(defineProps<Props>(), {
  as: "div",
})
</script>

<template>
  <Primitive
    role="group"
    :data-orientation="props.orientation"
    :as="as"
    :as-child="asChild"
    :class="cn(`bg-base-200 flex items-center gap-2 rounded-md border px-4 text-sm font-medium shadow-xs [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4`, props.class)"
  >
    <slot />
  </Primitive>
</template>
