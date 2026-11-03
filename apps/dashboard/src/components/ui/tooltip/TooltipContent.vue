<script setup lang="ts">
import type { Placement } from "@floating-ui/dom"
import type { HTMLAttributes } from "vue"
import { computed, inject, onBeforeUnmount, watch } from "vue"
import { popoverHintMode, useAnchoredPopover } from "@/lib/use-anchored-popover"
import { cn } from "@/lib/utils"
import { markTooltipClosed, tooltipKey } from "./context"

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
  /** Keep the tooltip closed, e.g. while the trigger already shows its label. */
  hidden?: boolean
  class?: HTMLAttributes["class"]
}>(), {
  side: "top",
  align: "center",
  sideOffset: 4,
  hidden: false,
})

const ctx = inject(tooltipKey)!

const placement = computed(() => (props.align === "center" ? props.side : `${props.side}-${props.align}`) as Placement)

const { floating: floatingRef, open, close, isOpen } = useAnchoredPopover({
  placement,
  offset: () => props.sideOffset,
  dismiss: true,
  captureEscape: true,
  restoreFocus: false,
  onClose: () => {
    if (ctx.open.value) { ctx.open.value = false; markTooltipClosed() }
  },
})

watch(() => props.hidden, hidden => { ctx.suppressed.value = hidden }, { immediate: true })
onBeforeUnmount(() => { ctx.suppressed.value = false })

watch([ctx.open, () => props.hidden], ([value, hidden]) => {
  const anchor = ctx.anchor()
  if (value && !hidden && anchor) open(anchor)
  else close()
}, { immediate: true, flush: "post" })

const mode = popoverHintMode()
function bindFloating(el: unknown) { floatingRef.value = el as HTMLElement | null }
</script>

<template>
  <div
    v-if="isOpen"
    :id="ctx.contentId"
    :ref="bindFloating"
    v-bind="$attrs"
    :popover="mode"
    role="tooltip"
    data-dismissable-layer
    data-slot="tooltip-content"
    :class="cn(
      'pointer-events-none z-50 w-fit max-w-xs rounded-md bg-neutral px-3 py-1.5 text-xs text-balance text-neutral-content',
      'ui-float',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
