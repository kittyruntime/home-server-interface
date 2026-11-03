<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { Check } from "@lucide/vue"
import MenuItem from "./MenuItem.vue"

const props = defineProps<{
  modelValue?: boolean | "indeterminate"
  disabled?: boolean
  textValue?: string
  class?: HTMLAttributes["class"]
}>()
const emit = defineEmits<{
  "update:modelValue": [value: boolean]
  select: [event: Event]
}>()

function onSelect(event: Event) {
  emit("select", event)
  if (!event.defaultPrevented) emit("update:modelValue", props.modelValue !== true)
}
</script>

<template>
  <MenuItem
    role="menuitemcheckbox"
    :checked="modelValue ?? false"
    :disabled="disabled"
    :text-value="textValue"
    :class="props.class"
    class="pl-8"
    @select="onSelect"
  >
    <template #indicator>
      <slot v-if="modelValue" name="indicator-icon">
        <Check class="size-4" />
      </slot>
    </template>
    <slot />
  </MenuItem>
</template>
