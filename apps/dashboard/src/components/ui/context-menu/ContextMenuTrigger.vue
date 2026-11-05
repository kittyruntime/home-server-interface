<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useMenuContext } from "@/lib/use-menu"
import type { PrimitiveProps } from "../Primitive.vue"
import Primitive from "../Primitive.vue"

/* Opens the menu at the pointer on a right-click, on a long press for touch,
   and from the Menu key or Shift+F10 on whatever is focused inside. Inputs
   keep the browser's own menu (cut, copy, paste). */
const props = withDefaults(defineProps<PrimitiveProps & { disabled?: boolean }>(), { as: "span" })
const ctx = useMenuContext()

const el = ref<InstanceType<typeof Primitive> | null>(null)
onMounted(() => { ctx.trigger.value = (el.value?.$el as HTMLElement | undefined) ?? null })
onBeforeUnmount(() => { ctx.trigger.value = null; cancelPress() })

const LONG_PRESS_MS = 700
let pressTimer: ReturnType<typeof setTimeout> | undefined
let keyboardOpenedAt = 0

const bindings = computed(() => ({
  "data-state": ctx.open.value ? "open" : "closed",
  "data-disabled": props.disabled ? "" : undefined,
}))

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
}

function onContextmenu(event: MouseEvent) {
  if (props.disabled || isEditable(event.target)) return
  event.preventDefault()
  // The Menu key also sends a contextmenu event, with no pointer position.
  if (Date.now() - keyboardOpenedAt < 100) return
  ctx.show({ x: event.clientX, y: event.clientY }, "content")
}

function onKeydown(event: KeyboardEvent) {
  if (props.disabled || isEditable(event.target)) return
  if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return
  const target = event.target instanceof Element ? event.target : ctx.trigger.value
  if (!target) return
  event.preventDefault()
  keyboardOpenedAt = Date.now()
  const rect = target.getBoundingClientRect()
  ctx.show({ x: rect.left + Math.min(rect.width / 2, 24), y: rect.bottom - Math.min(rect.height / 2, 12) }, "first")
}

function cancelPress() {
  clearTimeout(pressTimer)
  pressTimer = undefined
}

// A finger held still still sends pointermove events: only a real move (a
// scroll or a drag) cancels the long press.
const MOVE_TOLERANCE_PX = 10
let pressStart = { x: 0, y: 0 }

function onPointerdown(event: PointerEvent) {
  if (props.disabled || event.pointerType === "mouse" || isEditable(event.target)) return
  cancelPress()
  const { clientX, clientY } = event
  pressStart = { x: clientX, y: clientY }
  pressTimer = setTimeout(() => {
    pressTimer = undefined
    ctx.show({ x: clientX, y: clientY }, "content")
    swallowReleaseClick()
  }, LONG_PRESS_MS)
}

// The menu opens under the finger: the click the browser sends when it lifts
// would pick the item there. That one click is dropped.
function swallowReleaseClick() {
  let afterUp: ReturnType<typeof setTimeout> | undefined
  const swallow = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); done() }
  const lifted = () => { afterUp = setTimeout(done, 400) }
  const done = () => {
    clearTimeout(afterUp)
    window.removeEventListener("click", swallow, true)
    window.removeEventListener("pointerup", lifted, true)
    window.removeEventListener("pointerdown", done, true)
  }
  window.addEventListener("click", swallow, true)
  window.addEventListener("pointerup", lifted, true)
  window.addEventListener("pointerdown", done, true)
}

function onPointermove(event: PointerEvent) {
  if (pressTimer === undefined) return
  if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > MOVE_TOLERANCE_PX) cancelPress()
}
</script>

<template>
  <Primitive
    ref="el"
    data-slot="context-menu-trigger"
    v-bind="bindings"
    :as="props.as"
    :as-child="props.asChild"
    @contextmenu="onContextmenu"
    @keydown="onKeydown"
    @pointerdown="onPointerdown"
    @pointermove="onPointermove"
    @pointerup="cancelPress"
    @pointercancel="cancelPress"
  >
    <slot />
  </Primitive>
</template>
