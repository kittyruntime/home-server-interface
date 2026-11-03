<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useMenuContext } from "@/lib/use-menu"
import type { PrimitiveProps } from "../Primitive.vue"
import Primitive from "../Primitive.vue"

const props = withDefaults(defineProps<PrimitiveProps & { disabled?: boolean }>(), { as: "button" })
const ctx = useMenuContext()

const el = ref<InstanceType<typeof Primitive> | null>(null)
onMounted(() => { ctx.trigger.value = (el.value?.$el as HTMLElement | undefined) ?? null })
onBeforeUnmount(() => { ctx.trigger.value = null })

const bindings = computed(() => ({
  id: ctx.triggerId,
  "aria-haspopup": "menu",
  "aria-expanded": ctx.open.value,
  "aria-controls": ctx.open.value ? ctx.contentId : undefined,
  // Overridden by a child that sets its own data-state.
  "data-state": ctx.open.value ? "open" : "closed",
  "data-disabled": props.disabled ? "" : undefined,
  ...(props.as === "button" && !props.asChild ? { type: "button", disabled: props.disabled || undefined } : {}),
}))

function onClick(event: MouseEvent) {
  const trigger = ctx.trigger.value
  if (props.disabled || !trigger) return
  if (ctx.open.value) { ctx.open.value = false; return }
  // A click with no pointer behind it comes from the keyboard: start on the first item.
  ctx.show(trigger, event.detail === 0 ? "first" : "content")
}

function onKeydown(event: KeyboardEvent) {
  const trigger = ctx.trigger.value
  if (props.disabled || !trigger || ctx.open.value) return
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
  event.preventDefault()
  ctx.show(trigger, "first")
}
</script>

<template>
  <Primitive
    ref="el"
    data-slot="dropdown-menu-trigger"
    v-bind="bindings"
    :as="props.as"
    :as-child="props.asChild"
    @click="onClick"
    @keydown="onKeydown"
  >
    <slot />
  </Primitive>
</template>
