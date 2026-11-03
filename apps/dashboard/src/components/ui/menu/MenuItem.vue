<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { computed, ref } from "vue"
import { useMenuContext } from "@/lib/use-menu"
import { cn } from "@/lib/utils"
import { menuItemClass, menuSlot } from "./styles"

/* Entry of a dropdown or context menu: a plain item, or a checkbox or radio
   one. @select is cancelable: preventDefault keeps the menu open. */
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  disabled?: boolean
  /** Text typeahead matches against; defaults to the item's own text. */
  textValue?: string
  inset?: boolean
  variant?: "default" | "destructive"
  role?: "menuitem" | "menuitemcheckbox" | "menuitemradio"
  checked?: boolean | "indeterminate"
  class?: HTMLAttributes["class"]
}>(), {
  variant: "default",
  role: "menuitem",
  checked: undefined,
})
const emit = defineEmits<{ select: [event: Event] }>()

const ctx = useMenuContext()
const el = ref<HTMLElement | null>(null)

const ariaChecked = computed<"true" | "false" | "mixed" | undefined>(() => {
  if (props.role === "menuitem") return undefined
  if (props.checked === "indeterminate") return "mixed"
  return props.checked ? "true" : "false"
})

function onClick(event: MouseEvent) {
  if (props.disabled) {
    event.preventDefault()
    return
  }
  const select = new Event("select", { cancelable: true })
  emit("select", select)
  if (!select.defaultPrevented) ctx.dismiss()
}

// Hovering an item moves the focus to it, like the keyboard does.
function onPointermove() {
  if (!props.disabled && document.activeElement !== el.value) el.value?.focus({ preventScroll: true })
}
</script>

<template>
  <li role="none" :class="{ 'menu-disabled': disabled }">
    <button
      ref="el"
      v-bind="$attrs"
      type="button"
      tabindex="-1"
      :role="role"
      :aria-checked="ariaChecked"
      :aria-disabled="disabled ? 'true' : undefined"
      :data-slot="menuSlot(ctx.kind, role === 'menuitem' ? 'item' : role === 'menuitemcheckbox' ? 'checkbox-item' : 'radio-item')"
      :data-text-value="textValue"
      :data-inset="inset ? '' : undefined"
      :data-variant="variant"
      :data-disabled="disabled ? '' : undefined"
      :data-state="checked === undefined ? undefined : checked === 'indeterminate' ? 'indeterminate' : checked ? 'checked' : 'unchecked'"
      :class="cn(menuItemClass, props.class)"
      @click="onClick"
      @pointermove="onPointermove"
    >
      <span v-if="$slots.indicator" class="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
        <slot name="indicator" />
      </span>
      <slot />
    </button>
  </li>
</template>
