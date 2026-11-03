<script setup lang="ts">
import type { Placement } from "@floating-ui/dom"
import type { HTMLAttributes } from "vue"
import { computed, inject, watch } from "vue"
import { useAnchoredPopover } from "@/lib/use-anchored-popover"
import { cn } from "@/lib/utils"
import { popoverKey } from "./context"

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
  alignOffset?: number
  /** Move focus into the popover when it opens. */
  focusOnOpen?: boolean
  /** Return focus to the trigger when it closes with focus inside it. */
  restoreFocus?: boolean
  class?: HTMLAttributes["class"]
}>(), {
  side: "bottom",
  align: "center",
  sideOffset: 4,
  alignOffset: 0,
  focusOnOpen: true,
  restoreFocus: true,
})

const ctx = inject(popoverKey)!

const placement = computed(() => (props.align === "center" ? props.side : `${props.side}-${props.align}`) as Placement)

const FIRST_FOCUSABLE = "input:not(:disabled), button:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"

const { floating, open, close, isOpen } = useAnchoredPopover({
  placement,
  offset: () => props.sideOffset,
  alignOffset: () => props.alignOffset,
  dismiss: true,
  captureEscape: true,
  restoreFocus: props.restoreFocus,
  closeOnFocusOutside: true,
  onClose: () => { ctx.open.value = false },
  // The element is visible only once placed: focusing it earlier does nothing.
  onPlaced: (el) => {
    if (!props.focusOnOpen) return
    ;(el.querySelector<HTMLElement>(FIRST_FOCUSABLE) ?? el).focus({ preventScroll: true })
  },
})

watch(ctx.open, (value) => {
  if (!value) { close(); return }
  const anchor = ctx.anchor()
  if (!anchor) return
  open(anchor)
}, { immediate: true, flush: "post" })
</script>

<template>
  <div
    v-if="isOpen"
    :id="ctx.contentId"
    :ref="(el) => { floating = el as HTMLElement | null }"
    v-bind="$attrs"
    popover="manual"
    role="dialog"
    tabindex="-1"
    data-slot="popover-content"
    data-dismissable-layer
    :class="cn(
      'bg-base-100 text-base-content z-50 w-72 max-w-[calc(100vw-1rem)] rounded-md border p-4 shadow-md outline-hidden',
      'data-placed:animate-in data-placed:fade-in-0 data-placed:zoom-in-95 data-placed:motion-reduce:[animation:none]',
      'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
      props.class,
    )"
    @click.stop
  >
    <slot />
  </div>
</template>
