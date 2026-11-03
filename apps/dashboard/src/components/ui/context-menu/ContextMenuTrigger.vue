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

/* A press on a non-focusable row leaves focus on <body>, so nothing would take
   it back once an item opens a dialog and the menu is gone. The region itself
   becomes the focus target (programmatic only: it stays out of the tab order). */
function holdFocus() {
  const region = ctx.trigger.value
  if (!region || (document.activeElement && document.activeElement !== document.body)) return
  if (!region.hasAttribute("tabindex")) region.setAttribute("tabindex", "-1")
  region.focus({ preventScroll: true })
}

function onContextmenu(event: MouseEvent) {
  if (props.disabled || isEditable(event.target)) return
  event.preventDefault()
  // The Menu key also sends a contextmenu event, with no pointer position.
  if (Date.now() - keyboardOpenedAt < 100) return
  holdFocus()
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

function onPointerdown(event: PointerEvent) {
  if (props.disabled || event.pointerType === "mouse" || isEditable(event.target)) return
  cancelPress()
  const { clientX, clientY } = event
  pressTimer = setTimeout(() => { holdFocus(); ctx.show({ x: clientX, y: clientY }, "content") }, LONG_PRESS_MS)
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
    @pointermove="cancelPress"
    @pointerup="cancelPress"
    @pointercancel="cancelPress"
  >
    <slot />
  </Primitive>
</template>
