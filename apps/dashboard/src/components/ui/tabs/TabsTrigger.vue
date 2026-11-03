<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { PrimitiveProps } from "../Primitive.vue"
import { computed, inject, onMounted, onUnmounted, onUpdated } from "vue"
import { cn } from "@/lib/utils"
import Primitive from "../Primitive.vue"
import { makeId, tabsKey } from "./context"

interface TabsTriggerProps extends PrimitiveProps {
  value: string
  disabled?: boolean
  class?: HTMLAttributes["class"]
}

const props = withDefaults(defineProps<TabsTriggerProps>(), { as: "button", disabled: false })

const ctx = inject(tabsKey)!
const active = computed(() => ctx.model.value === props.value)

onMounted(ctx.refresh)
onUpdated(ctx.refresh)
onUnmounted(ctx.refresh)

function onFocus() {
  ctx.focused.value = props.value
  if (ctx.activationMode.value === "automatic" && !props.disabled)
    ctx.select(props.value)
}

function onMousedown(event: MouseEvent) {
  // Like a native tab: a left press selects, and a disabled one does not take focus
  if (props.disabled)
    event.preventDefault()
}

function onClick() {
  if (!props.disabled)
    ctx.select(props.value)
}
</script>

<template>
  <Primitive
    :as="props.as"
    :as-child="props.asChild"
    :type="props.as === 'button' ? 'button' : undefined"
    role="tab"
    data-slot="tabs-trigger"
    data-tab-trigger
    :data-value="value"
    :id="makeId(ctx.baseId, 'trigger', value)"
    :aria-selected="active"
    :aria-controls="makeId(ctx.baseId, 'content', value)"
    :data-state="active ? 'active' : 'inactive'"
    :data-orientation="ctx.orientation.value"
    :data-disabled="disabled ? '' : undefined"
    :disabled="disabled"
    :tabindex="ctx.stop.value === value ? 0 : -1"
    :class="cn('tab flex-1 gap-1.5 whitespace-nowrap', active ? 'tab-active' : 'text-base-content/90', props.class)"
    @focus="onFocus"
    @mousedown="onMousedown"
    @click="onClick"
  >
    <slot />
  </Primitive>
</template>
