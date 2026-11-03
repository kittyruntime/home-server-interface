<script setup lang="ts">
import type { PrimitiveProps } from "../Primitive.vue"
import { inject } from "vue"
import Primitive from "../Primitive.vue"
import { collapsibleKey } from "./context"

const props = withDefaults(defineProps<PrimitiveProps>(), { as: "button" })
const ctx = inject(collapsibleKey)!
</script>

<template>
  <Primitive
    :as="props.as"
    :as-child="props.asChild"
    :type="props.as === 'button' ? 'button' : undefined"
    data-slot="collapsible-trigger"
    :aria-controls="ctx.contentId"
    :aria-expanded="ctx.open.value"
    :data-state="ctx.open.value ? 'open' : 'closed'"
    :data-disabled="ctx.disabled.value ? '' : undefined"
    :disabled="ctx.disabled.value"
    @click="ctx.toggle()"
  >
    <slot />
  </Primitive>
</template>
