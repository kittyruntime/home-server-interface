<script lang="ts" setup>
import type { PrimitiveProps } from "../Primitive.vue"
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"
import Primitive from "../Primitive.vue"

const props = withDefaults(defineProps<PrimitiveProps & { class?: HTMLAttributes["class"] }>(), {
  as: "a",
})
</script>

<template>
  <Primitive
    data-slot="breadcrumb-link"
    :as="as"
    :as-child="asChild"
    :class="cn('hover:text-base-content transition-colors', props.class)"
  >
    <slot />
  </Primitive>
</template>
