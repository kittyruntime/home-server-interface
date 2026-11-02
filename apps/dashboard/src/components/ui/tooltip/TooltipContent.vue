<script setup lang="ts">
import type { Placement } from "@floating-ui/dom"
import type { HTMLAttributes } from "vue"
import { computed, inject, watch } from "vue"
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
  restoreFocus: false,
  onClose: () => {
    if (ctx.open.value) markTooltipClosed()
    ctx.open.value = false
  },
})

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
    data-slot="tooltip-content"
    :class="cn(
      'pointer-events-none z-50 w-fit max-w-xs rounded-md bg-neutral px-3 py-1.5 text-xs text-balance text-neutral-content',
      'data-placed:animate-in data-placed:fade-in-0 data-placed:zoom-in-95 data-placed:motion-reduce:[animation:none]',
      'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
