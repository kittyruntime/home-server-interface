<script setup lang="ts">
import type { PrimitiveProps } from "../Primitive.vue"
import { inject } from "vue"
import Primitive from "../Primitive.vue"
import { collapsibleKey } from "./context"

interface CollapsibleContentProps extends PrimitiveProps {
  /** Keep the content mounted, hidden, while closed. */
  forceMount?: boolean
}

const props = withDefaults(defineProps<CollapsibleContentProps>(), { forceMount: false, as: "div" })
const ctx = inject(collapsibleKey)!
</script>

<template>
  <Primitive
    v-if="ctx.open.value || forceMount"
    :as="props.as"
    :as-child="props.asChild"
    :id="ctx.contentId"
    data-slot="collapsible-content"
    :data-state="ctx.open.value ? 'open' : 'closed'"
    :data-disabled="ctx.disabled.value ? '' : undefined"
    :hidden="ctx.open.value ? undefined : true"
  >
    <slot />
  </Primitive>
</template>
