<script setup lang="ts">
import type { PrimitiveProps } from "../Primitive.vue"
import type { HTMLAttributes } from "vue"
import type { BadgeVariants } from "."
import { reactiveOmit } from "@vueuse/core"
import { cn } from "@/lib/utils"
import Primitive from "../Primitive.vue"
import { badgeVariants } from "."

const props = defineProps<PrimitiveProps & {
  variant?: BadgeVariants["variant"]
  class?: HTMLAttributes["class"]
}>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <Primitive
    data-slot="badge"
    :class="cn(badgeVariants({ variant }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
