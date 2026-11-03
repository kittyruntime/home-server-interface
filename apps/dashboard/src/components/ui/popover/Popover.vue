<script setup lang="ts">
import type { Ref } from "vue"
import { useVModel } from "@vueuse/core"
import { provide, shallowRef, useId } from "vue"
import { popoverKey } from "./context"

const props = withDefaults(defineProps<{
  open?: boolean
  defaultOpen?: boolean
  /** Accepted for compatibility: a popover never blocks the page. */
  modal?: boolean
}>(), {
  open: undefined,
  defaultOpen: false,
  modal: false,
})
const emit = defineEmits<{ "update:open": [value: boolean] }>()

const open = useVModel(props, "open", emit, { passive: true, defaultValue: props.defaultOpen }) as Ref<boolean>

const trigger = shallowRef<HTMLElement | null>(null)
const anchor = shallowRef<HTMLElement | null>(null)

provide(popoverKey, {
  open,
  anchor: () => anchor.value ?? trigger.value,
  setTrigger: el => { trigger.value = el },
  setAnchor: el => { anchor.value = el },
  contentId: useId(),
  toggle: () => { open.value = !open.value },
})
</script>

<template>
  <slot :open="open" />
</template>
