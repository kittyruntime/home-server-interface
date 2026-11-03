<script setup lang="ts">
import type { Placement } from "@floating-ui/dom"
import type { HTMLAttributes } from "vue"
import { computed } from "vue"
import { useMenuContent, useMenuContext } from "@/lib/use-menu"
import { cn } from "@/lib/utils"
import { menuContentClass, menuSlot } from "./styles"

/* Content of a dropdown, a context menu or a submenu. It stays where it is
   declared (no teleport) and is shown in the top layer, so a modal or a
   desktop window neither hides nor clips it. */
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
  alignOffset?: number
  class?: HTMLAttributes["class"]
}>(), {
  side: "bottom",
  align: "center",
  sideOffset: 4,
  alignOffset: 0,
})

const ctx = useMenuContext()

// A context menu opens with its corner at the pointer.
const atPoint = computed(() => !!ctx.anchor.value && !(ctx.anchor.value instanceof HTMLElement))
const placement = computed<Placement>(() => {
  if (atPoint.value) return "bottom-start"
  return props.align === "center" ? props.side : `${props.side}-${props.align}`
})

// A dropdown or submenu is named by its button; a context menu has none.
const labelledby = computed(() => (ctx.kind === "dropdown" || ctx.isSub ? ctx.trigger.value?.id || undefined : undefined))

const { floating, isOpen, onKeydown, stop, onContextmenu } = useMenuContent(ctx, {
  placement,
  offset: () => (atPoint.value ? 0 : props.sideOffset),
  alignOffset: () => (atPoint.value ? 0 : props.alignOffset),
})

function bindFloating(el: unknown) { floating.value = el as HTMLElement | null }
</script>

<template>
  <ul
    v-if="isOpen"
    :id="ctx.contentId"
    :ref="bindFloating"
    v-bind="$attrs"
    popover="manual"
    role="menu"
    tabindex="-1"
    aria-orientation="vertical"
    :aria-labelledby="labelledby"
    :data-slot="menuSlot(ctx.kind, ctx.isSub ? 'sub-content' : 'content')"
    data-dismissable-layer
    :class="cn(menuContentClass, props.class)"
    @keydown="onKeydown"
    @click="stop"
    @dblclick="stop"
    @pointerdown="stop"
    @mousedown="stop"
    @contextmenu="onContextmenu"
  >
    <slot />
  </ul>
</template>
