<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { PrimitiveProps } from "../Primitive.vue"
import { computed, inject } from "vue"
import { cn } from "@/lib/utils"
import Primitive from "../Primitive.vue"
import { makeId, tabsKey } from "./context"

interface TabsContentProps extends PrimitiveProps {
  value: string
  /** Keep the panel mounted, hidden, while inactive. */
  forceMount?: boolean
  class?: HTMLAttributes["class"]
}

const props = withDefaults(defineProps<TabsContentProps>(), { forceMount: false, as: "div" })

const ctx = inject(tabsKey)!
const active = computed(() => ctx.model.value === props.value)
</script>

<template>
  <Primitive
    v-if="active || forceMount"
    :as="props.as"
    :as-child="props.asChild"
    role="tabpanel"
    data-slot="tabs-content"
    :id="makeId(ctx.baseId, 'content', value)"
    :aria-labelledby="makeId(ctx.baseId, 'trigger', value)"
    :data-state="active ? 'active' : 'inactive'"
    :data-orientation="ctx.orientation.value"
    :hidden="active ? undefined : true"
    tabindex="0"
    :class="cn('flex-1 outline-none', props.class)"
  >
    <slot />
  </Primitive>
</template>
