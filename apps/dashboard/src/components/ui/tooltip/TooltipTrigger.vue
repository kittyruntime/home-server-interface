<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref } from "vue"
import type { PrimitiveProps } from "../Primitive.vue"
import Primitive from "../Primitive.vue"
import { markTooltipClosed, recentlyClosed, tooltipKey } from "./context"

/* Shows on mouse hover and on keyboard focus. A touch has no hover and a
   tap's focus is not :focus-visible, so a tooltip never gets in a tap's way. */
const props = withDefaults(defineProps<PrimitiveProps>(), { as: "button" })
const ctx = inject(tooltipKey)!

const el = ref<InstanceType<typeof Primitive> | null>(null)
onMounted(() => ctx.setTrigger((el.value?.$el as HTMLElement | undefined) ?? null))
onBeforeUnmount(() => { clear(); ctx.setTrigger(null) })

let timer: ReturnType<typeof setTimeout> | undefined
function clear() { clearTimeout(timer); timer = undefined }

function show(immediate: boolean) {
  clear()
  if (ctx.open.value) return
  const delay = immediate || recentlyClosed() ? 0 : ctx.delay()
  if (delay <= 0) ctx.open.value = true
  else timer = setTimeout(() => { ctx.open.value = true }, delay)
}

function hide() {
  clear()
  if (!ctx.open.value) return
  ctx.open.value = false
  markTooltipClosed()
}

function onPointerenter(event: PointerEvent) {
  if (event.pointerType === "touch") return
  show(false)
}

function onFocus(event: FocusEvent) {
  if ((event.target as HTMLElement).matches(":focus-visible")) show(true)
}
</script>

<template>
  <Primitive
    ref="el"
    :as="props.as"
    :as-child="props.asChild"
    :aria-describedby="ctx.open.value ? ctx.contentId : undefined"
    @pointerenter="onPointerenter"
    @pointerleave="hide"
    @pointerdown="hide"
    @focus="onFocus"
    @blur="hide"
  >
    <slot />
  </Primitive>
</template>
