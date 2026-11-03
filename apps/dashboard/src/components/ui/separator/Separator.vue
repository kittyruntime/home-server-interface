<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { computed } from "vue"
import { cn } from "@/lib/utils"
import Primitive from "../Primitive.vue"

// A bare line: daisyUI's divider adds margins and a text slot that the
// toolbars sizing it with data-[orientation=*] classes do not want.
const props = withDefaults(defineProps<{
  orientation?: "horizontal" | "vertical"
  /** Purely visual: hidden from assistive tech. */
  decorative?: boolean
  as?: string | object
  asChild?: boolean
  class?: HTMLAttributes["class"]
}>(), {
  orientation: "horizontal",
  decorative: true,
  as: "div",
})

const semantics = computed(() => props.decorative
  ? { role: "none" }
  : { "role": "separator", "aria-orientation": props.orientation === "vertical" ? "vertical" : undefined })
</script>

<template>
  <Primitive
    data-slot="separator"
    :as="as"
    :as-child="asChild"
    :data-orientation="orientation"
    v-bind="semantics"
    :class="
      cn(
        'bg-base-300 shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        props.class,
      )
    "
  />
</template>
