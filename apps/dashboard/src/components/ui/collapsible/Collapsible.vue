<script setup lang="ts">
import type { PrimitiveProps } from "../Primitive.vue"
import { computed, provide, ref, useId } from "vue"
import Primitive from "../Primitive.vue"
import { collapsibleKey } from "./context"

interface CollapsibleProps extends PrimitiveProps {
  open?: boolean
  defaultOpen?: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<CollapsibleProps>(), {
  open: undefined,
  defaultOpen: false,
  disabled: false,
  as: "div",
})

const emits = defineEmits<{
  "update:open": [value: boolean]
}>()

const local = ref(props.defaultOpen)
const open = computed(() => props.open !== undefined ? props.open : local.value)

function toggle() {
  if (props.disabled)
    return
  local.value = !open.value
  emits("update:open", local.value)
}

provide(collapsibleKey, {
  contentId: `collapsible-${useId()}`,
  open,
  disabled: computed(() => props.disabled),
  toggle,
})
</script>

<template>
  <Primitive
    :as="props.as"
    :as-child="props.asChild"
    data-slot="collapsible"
    :data-state="open ? 'open' : 'closed'"
    :data-disabled="disabled ? '' : undefined"
  >
    <slot :open="open" />
  </Primitive>
</template>
