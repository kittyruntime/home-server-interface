<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { ChevronRight } from "@lucide/vue"
import { onMounted, ref, watch } from "vue"
import { useMenuContext } from "@/lib/use-menu"
import { cn } from "@/lib/utils"
import { menuItemClass, menuSlot } from "./styles"

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  disabled?: boolean
  textValue?: string
  inset?: boolean
  class?: HTMLAttributes["class"]
}>()

const ctx = useMenuContext()
const el = ref<HTMLElement | null>(null)
onMounted(() => { ctx.trigger.value = el.value })

// After the submenu closes with the pointer still on the trigger (Esc, ArrowLeft),
// the next pointermove must not open it again: only leaving and coming back does.
let hoverSuppressed = false
watch(ctx.open, (value) => {
  if (!value && el.value?.matches(":hover")) hoverSuppressed = true
})

function openSub(focus: "first" | "content" | "none") {
  if (props.disabled || !el.value || ctx.open.value) return
  ctx.show(el.value, focus)
}

function onClick(event: MouseEvent) {
  openSub(event.detail === 0 ? "first" : "content")
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "ArrowRight") return
  event.preventDefault()
  openSub("first")
}

// Hovering moves the focus here and opens the submenu without taking it.
function onPointermove() {
  if (props.disabled) return
  if (document.activeElement !== el.value) el.value?.focus({ preventScroll: true })
  if (!hoverSuppressed) openSub("none")
}

function onPointerleave() {
  hoverSuppressed = false
}
</script>

<template>
  <button
    :id="ctx.triggerId"
    ref="el"
    v-bind="$attrs"
    type="button"
    tabindex="-1"
    role="menuitem"
    aria-haspopup="menu"
    :aria-expanded="ctx.open.value"
    :aria-controls="ctx.open.value ? ctx.contentId : undefined"
    :aria-disabled="disabled ? 'true' : undefined"
    :data-slot="menuSlot(ctx.kind, 'sub-trigger')"
    :data-text-value="textValue"
    :data-inset="inset ? '' : undefined"
    :data-state="ctx.open.value ? 'open' : 'closed'"
    :data-disabled="disabled ? '' : undefined"
    :class="cn(menuItemClass, 'data-[state=open]:bg-base-content/10 data-[disabled]:pointer-events-none data-[disabled]:opacity-50', props.class)"
    @click="onClick"
    @keydown="onKeydown"
    @pointermove="onPointermove"
    @pointerleave="onPointerleave"
  >
    <slot />
    <ChevronRight class="ml-auto" />
  </button>
</template>
