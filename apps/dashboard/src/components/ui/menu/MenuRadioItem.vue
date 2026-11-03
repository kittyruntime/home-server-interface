<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { Circle } from "@lucide/vue"
import { inject } from "vue"
import MenuItem from "./MenuItem.vue"
import { radioGroupKey } from "@/lib/use-menu"

const props = defineProps<{
  value: string
  disabled?: boolean
  textValue?: string
  class?: HTMLAttributes["class"]
}>()
const emit = defineEmits<{ select: [event: Event] }>()

const group = inject(radioGroupKey, null)

function checked() {
  return group?.value() === props.value
}

function onSelect(event: Event) {
  emit("select", event)
  if (!event.defaultPrevented) group?.select(props.value)
}
</script>

<template>
  <MenuItem
    role="menuitemradio"
    :checked="checked()"
    :disabled="disabled"
    :text-value="textValue"
    :class="props.class"
    class="pl-8"
    @select="onSelect"
  >
    <template #indicator>
      <slot v-if="checked()" name="indicator-icon">
        <Circle class="size-2 fill-current" />
      </slot>
    </template>
    <slot />
  </MenuItem>
</template>
